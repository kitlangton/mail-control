import path from "node:path"
import { createCliRenderer, type PasteEvent, parseColor, SyntaxStyle, TextAttributes } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { Cache, Effect, Layer, ManagedRuntime, Option } from "effect"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import type { AccountEnv } from "./account.js"
import {
  archiveMessage,
  type ListInput,
  listMessages,
  markMessageRead,
  readMessage,
  trashMessage,
  unsubscribeFromMessage,
} from "./app.js"
import { Accounts } from "./config.js"
import { mailLayer } from "./layers.js"
import { messageBodyContent } from "./message-body.js"
import { TuiCache } from "./tui-cache.js"
import type { MailMessageBody, MailMessageSummary, MailStatus } from "./types.js"

const colors = {
  background: "#111018",
  panel: "#1a1a2e",
  selected: "#1d2430",
  border: "#6f685d",
  text: "#ede7da",
  selectedText: "#f8fafc",
  muted: "#9f9788",
  accent: "#f4a51c",
  count: "#d7c5a1",
  error: "#f97316",
}

type LoadState = "loading" | "ready" | "error"
type Action = "archive" | "trash" | "read" | "unsubscribe"
type MailScope = "inbox" | "all"

const actionLabels: Record<Action, readonly [progress: string, complete: string]> = {
  archive: ["Archiving", "Archived"],
  trash: ["Trashing", "Trashed"],
  read: ["Marking read", "Marked read"],
  unsubscribe: ["Unsubscribing", "Unsubscribed"],
}

interface ListView {
  readonly account: string
  readonly status: MailStatus
  readonly scope: MailScope
  readonly query: string
}

interface LoadedMessage {
  readonly key: string
  readonly message: MailMessageBody
}

const tuiCacheLayer = Layer.unwrap(
  Effect.map(Accounts, ({ dir }) => TuiCache.layerFromPath(path.join(dir, "cache.sqlite"))),
).pipe(Layer.provide(mailLayer))
const runtime = ManagedRuntime.make(Layer.merge(mailLayer, tuiCacheLayer))
const run = <A, E, R extends AccountEnv>(effect: Effect.Effect<A, E, R>) => runtime.runPromise(effect)
const cacheKey = (message: Pick<MailMessageSummary, "account" | "id">) => `${message.account}\u0000${message.id}`
const messageCache = runtime.runPromise(
  Cache.make({
    capacity: 500,
    timeToLive: "30 minutes",
    lookup: (key: string) => {
      const separator = key.indexOf("\u0000")
      return readMessage({ account: key.slice(0, separator), id: key.slice(separator + 1) })
    },
  }),
)
const readCachedMessage = async (summary: MailMessageSummary) => {
  const cache = await messageCache
  const key = cacheKey(summary)
  const memory = await runtime.runPromise(Cache.getSuccess(cache, key))
  if (Option.isSome(memory)) return memory.value
  const persistent = await runtime.runPromise(Effect.flatMap(TuiCache, (store) => store.readBody(key)))
  if (persistent) {
    await runtime.runPromise(Cache.set(cache, key, persistent))
    return persistent
  }
  const message = await runtime.runPromise(Cache.get(cache, key))
  await runtime.runPromise(Effect.flatMap(TuiCache, (store) => store.writeBody(key, message)))
  return message
}
const listViewKey = (view: ListView) =>
  new URLSearchParams({
    account: view.account,
    status: view.status,
    scope: view.scope,
    query: view.query,
  }).toString()
const listViewFromKey = (key: string): ListView => {
  const params = new URLSearchParams(key)
  const status = params.get("status")
  return {
    account: params.get("account") ?? "all",
    status: status === "read" || status === "unread" ? status : "all",
    scope: params.get("scope") === "all" ? "all" : "inbox",
    query: params.get("query") ?? "",
  }
}
const listInputFrom = (view: ListView): ListInput => ({
  account: view.account,
  maxResults: 100,
  status: view.status,
  scope: view.scope === "all" || view.query ? "search" : "inbox",
  ...(view.query ? { query: view.query } : {}),
})
const updateListAfterMutation = (
  messages: readonly MailMessageSummary[],
  view: ListView,
  action: Exclude<Action, "unsubscribe">,
  targetKey: string,
): readonly MailMessageSummary[] => {
  if (action === "read") {
    return view.status === "unread"
      ? messages.filter((item) => cacheKey(item) !== targetKey)
      : messages.map((item) => (cacheKey(item) === targetKey ? { ...item, unread: false } : item))
  }
  if (action === "archive" && (view.scope === "all" || view.query)) return messages
  return messages.filter((item) => cacheKey(item) !== targetKey)
}
const listViewCache = runtime.runPromise(
  Cache.make({
    capacity: 100,
    timeToLive: "5 minutes",
    lookup: (key: string) => listMessages(listInputFrom(listViewFromKey(key))),
  }),
)

const seedAccountViews = async (view: ListView, messages: readonly MailMessageSummary[]) => {
  if (view.account !== "all") return
  const [memory, store, accountIds] = await Promise.all([
    listViewCache,
    runtime.runPromise(TuiCache),
    runtime.runPromise(Effect.map(Accounts, ({ ids }) => ids.map(String))),
  ])
  const complete = messages.length < 100

  await Promise.all(
    accountIds.map(async (account) => {
      const accountView = { ...view, account }
      const key = listViewKey(accountView)
      const existing = await runtime.runPromise(Cache.getSuccess(memory, key))
      if (Option.isSome(existing)) return
      const persisted = await runtime.runPromise(store.readList(key))
      if (persisted && (complete || persisted.fetchedAt > 0)) return
      const accountMessages = messages.filter((message) => String(message.account) === account)
      await runtime.runPromise(store.writeList(key, accountMessages, complete ? Date.now() : 0))
      if (complete) await runtime.runPromise(Cache.set(memory, key, accountMessages))
    }),
  )
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ")
const truncate = (value: string, width: number) =>
  value.length <= width ? value : `${value.slice(0, Math.max(0, width - 3))}...`

const markdownSyntaxStyle = SyntaxStyle.fromStyles({
  keyword: { fg: parseColor(colors.accent), bold: true },
  string: { fg: parseColor(colors.count) },
  comment: { fg: parseColor(colors.muted), italic: true },
  number: { fg: parseColor(colors.count) },
  function: { fg: parseColor(colors.accent) },
  type: { fg: parseColor(colors.count) },
  operator: { fg: parseColor(colors.text) },
  punctuation: { fg: parseColor(colors.text) },
  default: { fg: parseColor(colors.text) },
})

const accountLabel = (account: string) =>
  ({ all: "All", gmail: "Gmail", anomaly: "Anomaly", vish: "Vish", icloud: "iCloud" })[account] ?? account

const Line = ({ children }: { readonly children: ReactNode }) => (
  <box height={1}>
    <text wrapMode="none" truncate>
      {children}
    </text>
  </box>
)

const Divider = ({
  width,
  junctions = [],
}: {
  readonly width: number
  readonly junctions?: readonly { readonly at: number; readonly char: string }[]
}) => {
  const length = Math.max(1, width)
  let content = "─".repeat(length)
  if (junctions.length > 0) {
    const byColumn = new Map(junctions.map(({ at, char }) => [at, char]))
    content = Array.from({ length }, (_, index) => byColumn.get(index) ?? "─").join("")
  }
  return (
    <box width={width} height={1}>
      <text wrapMode="none" truncate fg={colors.border}>
        {content}
      </text>
    </box>
  )
}

const VerticalSeparator = ({
  height,
  junctions = [],
}: {
  readonly height: number
  readonly junctions?: readonly { readonly row: number; readonly char: string }[]
}) => {
  const byRow = new Map(junctions.map(({ row, char }) => [row, char]))
  return (
    <box width={1} height={height} flexDirection="column">
      {Array.from({ length: height }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed, stateless terminal rows
        <box key={index} width={1} height={1}>
          <text fg={colors.border}>{byRow.get(index) ?? "│"}</text>
        </box>
      ))}
    </box>
  )
}

const installWindowFetch = () => {
  const browserWindow = Reflect.get(globalThis, "window")
  if (
    typeof browserWindow === "object" &&
    browserWindow !== null &&
    typeof Reflect.get(browserWindow, "fetch") !== "function"
  ) {
    Reflect.set(browserWindow, "fetch", globalThis.fetch)
  }
}

const shortcutGroups = [
  {
    title: "NAVIGATE",
    rows: [
      ["j / down", "next message"],
      ["k / up", "previous message"],
      ["enter", "open message"],
      ["tab / right", "next mailbox"],
      ["shift-tab / left", "previous mailbox"],
    ],
  },
  {
    title: "FILTER",
    rows: [
      ["i", "inbox / all mail"],
      ["u", "unread / all"],
      ["/", "search all mail"],
      ["esc", "back / clear search"],
    ],
  },
  {
    title: "ACT",
    rows: [
      ["r", "refresh this view"],
      ["a", "archive"],
      ["d / delete / ⌫", "trash"],
      ["m", "mark read"],
      ["x", "unsubscribe"],
      ["q", "quit"],
    ],
  },
] as const

const ShortcutModal = ({
  terminalWidth,
  terminalHeight,
}: {
  readonly terminalWidth: number
  readonly terminalHeight: number
}) => {
  const width = Math.min(58, Math.max(36, terminalWidth - 4))
  const bodyRows = shortcutGroups.reduce((total, group) => total + group.rows.length + 1, 0)
  const height = bodyRows + 6
  const innerWidth = width - 2
  const left = Math.max(0, Math.floor((terminalWidth - width) / 2))
  const top = Math.max(0, Math.floor((terminalHeight - height) / 2))
  const border = "─".repeat(innerWidth)

  const framedLine = (key: string, content: ReactNode) => (
    <box key={key} height={1} flexDirection="row">
      <text fg={colors.border}>│</text>
      <box width={innerWidth} height={1} paddingLeft={1} paddingRight={1}>
        <Line>{content}</Line>
      </box>
      <text fg={colors.border}>│</text>
    </box>
  )

  return (
    <box
      position="absolute"
      left={left}
      top={top}
      width={width}
      height={height}
      zIndex={100}
      flexDirection="column"
      backgroundColor={colors.panel}
    >
      <Line>
        <span fg={colors.border}>{`┌${border}┐`}</span>
      </Line>
      {framedLine(
        "title",
        <span fg={colors.accent} attributes={TextAttributes.BOLD}>
          SHORTCUTS
        </span>,
      )}
      <Line>
        <span fg={colors.border}>{`├${border}┤`}</span>
      </Line>
      {shortcutGroups.flatMap((group) => [
        framedLine(`group-${group.title}`, <span fg={colors.muted}>{group.title}</span>),
        ...group.rows.map(([key, label]) =>
          framedLine(
            `${group.title}-${key}`,
            <>
              <span fg={colors.count}>{key.padEnd(18)}</span>
              <span fg={colors.text}>{label}</span>
            </>,
          ),
        ),
      ])}
      <Line>
        <span fg={colors.border}>{`├${border}┤`}</span>
      </Line>
      {framedLine(
        "footer",
        <>
          <span fg={colors.count}>? / esc</span>
          <span fg={colors.muted}> close</span>
        </>,
      )}
      <Line>
        <span fg={colors.border}>{`└${border}┘`}</span>
      </Line>
    </box>
  )
}

const MailApp = () => {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const [accounts, setAccounts] = useState<readonly string[]>([])
  const [account, setAccount] = useState("all")
  const [status, setStatus] = useState<MailStatus>("all")
  const [scope, setScope] = useState<MailScope>("inbox")
  const [messages, setMessages] = useState<readonly MailMessageSummary[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [loadedMessage, setLoadedMessage] = useState<LoadedMessage | null>(null)
  const [loadState, setLoadState] = useState<LoadState>("loading")
  const [detailState, setDetailState] = useState<LoadState>("loading")
  const [notice, setNotice] = useState("Loading inbox...")
  const [refreshKey, setRefreshKey] = useState(0)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState("")
  const [searchDraft, setSearchDraft] = useState("")
  const [showDetail, setShowDetail] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const searchingRef = useRef(searching)
  const searchDraftRef = useRef(searchDraft)
  const forceRefreshRef = useRef(false)
  const viewRef = useRef<ListView>({ account, status, scope, query })
  searchingRef.current = searching
  searchDraftRef.current = searchDraft
  viewRef.current = { account, status, scope, query }

  const accountChoices = ["all", ...accounts]
  const groupedMessages = (() => {
    if (account !== "all") return messages
    const buckets = new Map<string, MailMessageSummary[]>()
    for (const item of messages) {
      const id = String(item.account)
      const bucket = buckets.get(id)
      if (bucket) bucket.push(item)
      else buckets.set(id, [item])
    }
    const ordered: MailMessageSummary[] = []
    for (const id of accounts) {
      const bucket = buckets.get(id)
      if (bucket) ordered.push(...bucket)
      buckets.delete(id)
    }
    for (const bucket of buckets.values()) ordered.push(...bucket)
    return ordered
  })()
  const foundSelected = selectedKey === null ? 0 : groupedMessages.findIndex((item) => cacheKey(item) === selectedKey)
  const selected = Math.max(0, foundSelected)
  const selectedMessage = groupedMessages[selected]
  const selectedMessageKey = selectedMessage ? cacheKey(selectedMessage) : null
  const previousMessage = groupedMessages[selected - 1]
  const nextMessage = groupedMessages[selected + 1]
  const message = loadedMessage?.key === selectedMessageKey ? loadedMessage.message : null
  const renderedBody = useMemo(() => (message ? messageBodyContent(message) : null), [message])
  const compact = width < 90
  const bodyHeight = Math.max(4, height - 4)
  const listWidth = compact ? width : Math.max(34, Math.floor(width * 0.42))
  const detailWidth = compact ? width : width - listWidth - 1
  const detailDividerRow = message ? 3 + (message.attachments?.length ? 1 : 0) : null
  const viewTitle = searching || query ? "Search All Mail" : scope === "inbox" ? "Inbox" : "All Mail"

  useEffect(() => {
    renderer.setBackgroundColor(colors.background)
    void runtime.runPromise(Effect.flatMap(TuiCache, (store) => store.prune()))
    void run(Effect.map(Accounts, ({ ids }) => ids.map(String))).then(setAccounts, (error) => {
      setLoadState("error")
      setNotice(errorText(error))
    })
  }, [renderer])

  useEffect(() => {
    const handlePaste = (event: PasteEvent) => {
      if (!searchingRef.current) return
      const next = searchDraftRef.current + new TextDecoder().decode(event.bytes).replace(/[\r\n]/g, " ")
      searchDraftRef.current = next
      setSearchDraft(next)
      event.preventDefault()
    }
    renderer.keyInput.on("paste", handlePaste)
    return () => {
      renderer.keyInput.off("paste", handlePaste)
    }
  }, [renderer])

  useEffect(() => {
    void refreshKey
    let active = true
    const view: ListView = { account, status, scope, query }
    const key = listViewKey(view)
    const forceRefresh = forceRefreshRef.current
    forceRefreshRef.current = false

    void listViewCache
      .then(async (cache) => {
        const cached = await runtime.runPromise(Cache.getSuccess(cache, key))
        if (!active) return
        if (Option.isSome(cached)) {
          setMessages(cached.value)
          setSelectedKey(null)
          setLoadState("ready")
          setNotice("")
          void seedAccountViews(view, cached.value)
          return
        }

        const store = await runtime.runPromise(TuiCache)
        const persisted = await runtime.runPromise(store.readList(key))
        if (!active) return
        if (persisted && !forceRefresh) {
          await runtime.runPromise(Cache.set(cache, key, persisted.messages))
          setMessages(persisted.messages)
          setSelectedKey(null)
          setLoadState("ready")
          setNotice("")
          void seedAccountViews(view, persisted.messages)
          if (Date.now() - persisted.fetchedAt < 5 * 60 * 1000) return

          const refreshed = await runtime.runPromise(Cache.refresh(cache, key)).catch(() => null)
          if (!active) return
          if (!refreshed) {
            setNotice("Refresh failed; showing cached mail")
            return
          }
          await runtime.runPromise(Cache.set(cache, key, refreshed))
          await runtime.runPromise(store.writeList(key, refreshed))
          setMessages(refreshed)
          setSelectedKey(null)
          setNotice("")
          void seedAccountViews(view, refreshed)
          return
        }

        if (forceRefresh) {
          setNotice("Refreshing...")
        } else {
          setMessages([])
          setSelectedKey(null)
          setLoadState("loading")
          setNotice(query ? "Searching..." : "Loading inbox...")
        }
        const next = await runtime.runPromise(Cache.get(cache, key))
        if (active) {
          await runtime.runPromise(store.writeList(key, next))
          setMessages(next)
          setSelectedKey(null)
          setLoadState("ready")
          setNotice("")
          void seedAccountViews(view, next)
        }
      })
      .catch((error) => {
        if (active) {
          setLoadState("error")
          setNotice(errorText(error))
        }
      })
    return () => {
      active = false
    }
  }, [account, status, scope, query, refreshKey])

  useEffect(() => {
    if (!selectedMessage || (compact && !showDetail)) {
      setLoadedMessage(null)
      setDetailState("ready")
      return
    }
    let active = true
    setLoadedMessage(null)
    setDetailState("loading")
    void readCachedMessage(selectedMessage).then(
      (next) => {
        if (!active) return
        setLoadedMessage({ key: cacheKey(selectedMessage), message: next })
        setDetailState("ready")
        for (const neighbor of [previousMessage, nextMessage]) {
          if (neighbor) void readCachedMessage(neighbor).catch(() => {})
        }
      },
      (error) => {
        if (!active) return
        setDetailState("error")
        setNotice(errorText(error))
      },
    )
    return () => {
      active = false
    }
  }, [compact, nextMessage, previousMessage, selectedMessage, showDetail])

  const cycleAccount = (direction: 1 | -1) => {
    setAccount((current) => {
      const nextIndex = (accountChoices.indexOf(current) + direction + accountChoices.length) % accountChoices.length
      return accountChoices[nextIndex] ?? "all"
    })
  }

  const moveSelection = (direction: 1 | -1) => {
    setSelectedKey((current) => {
      const found = current === null ? 0 : groupedMessages.findIndex((item) => cacheKey(item) === current)
      const index = Math.max(0, found)
      const nextIndex = Math.max(0, Math.min(groupedMessages.length - 1, index + direction))
      const next = groupedMessages[nextIndex]
      return next ? cacheKey(next) : null
    })
  }

  const mutate = (action: Action) => {
    if (!selectedMessage) return
    const view: ListView = { account, status, scope, query }
    const viewKey = listViewKey(view)
    const messageKey = cacheKey(selectedMessage)
    const input = { account: String(selectedMessage.account), id: selectedMessage.id }
    const effect =
      action === "archive"
        ? archiveMessage(input)
        : action === "trash"
          ? trashMessage(input)
          : action === "read"
            ? markMessageRead(input)
            : unsubscribeFromMessage(input)
    const [progressLabel, completeLabel] = actionLabels[action]
    setNotice(`${progressLabel}...`)
    void run(effect).then(
      async () => {
        setNotice(`${completeLabel}: ${selectedMessage.subject}`)
        if (action === "unsubscribe") return

        const nextMessages = updateListAfterMutation(messages, view, action, messageKey)

        if (listViewKey(viewRef.current) === viewKey) setMessages(nextMessages)

        const [cache, store] = await Promise.all([listViewCache, runtime.runPromise(TuiCache)])
        const keys = Array.from(await runtime.runPromise(Cache.keys(cache)))
        const snapshots = await Promise.all(
          keys.map(async (key) => [key, await runtime.runPromise(Cache.getSuccess(cache, key))] as const),
        )
        const updates = new Map<string, readonly MailMessageSummary[]>([[viewKey, nextMessages]])
        for (const [key, snapshot] of snapshots) {
          if (key !== viewKey && Option.isSome(snapshot)) {
            updates.set(key, updateListAfterMutation(snapshot.value, listViewFromKey(key), action, messageKey))
          }
        }
        await runtime.runPromise(store.clearLists())
        await Promise.all(
          Array.from(updates, ([key, next]) =>
            Promise.all([
              runtime.runPromise(Cache.set(cache, key, next)),
              runtime.runPromise(store.writeList(key, next)),
            ]),
          ),
        )
      },
      (error) => setNotice(errorText(error)),
    )
  }

  useKeyboard((key) => {
    if (searching) {
      if (key.name === "escape") {
        setSearching(false)
      } else if (key.name === "return") {
        setSearching(false)
        setQuery(searchDraftRef.current.trim())
      } else if (key.name === "backspace") {
        const next = searchDraftRef.current.slice(0, -1)
        searchDraftRef.current = next
        setSearchDraft(next)
      } else if (!key.ctrl && !key.meta && key.sequence.length > 0 && key.sequence.charCodeAt(0) >= 32) {
        const next = searchDraftRef.current + key.sequence
        searchDraftRef.current = next
        setSearchDraft(next)
      }
      return
    }
    if (showShortcuts) {
      if (key.name === "escape" || key.sequence === "?") setShowShortcuts(false)
      return
    }
    if (key.name === "q" || (key.ctrl && key.name === "c")) void renderer.destroy()
    else if (key.name === "j" || key.name === "down") moveSelection(1)
    else if (key.name === "k" || key.name === "up") moveSelection(-1)
    else if (key.name === "tab") cycleAccount(key.shift ? -1 : 1)
    else if (key.name === "left") cycleAccount(-1)
    else if (key.name === "right") cycleAccount(1)
    else if (key.name === "u") setStatus((value) => (value === "unread" ? "all" : "unread"))
    else if (key.name === "i") setScope((value) => (value === "inbox" ? "all" : "inbox"))
    else if (key.sequence === "?") setShowShortcuts(true)
    else if (key.name === "/") {
      searchDraftRef.current = query
      setSearchDraft(query)
      setSearching(true)
    } else if (key.name === "return" && compact) setShowDetail(true)
    else if (key.name === "escape" && compact && showDetail) setShowDetail(false)
    else if (key.name === "escape" && query) {
      setQuery("")
      setSearchDraft("")
    } else if (key.name === "r") {
      const view: ListView = { account, status, scope, query }
      forceRefreshRef.current = true
      void listViewCache
        .then((cache) => runtime.runPromise(Cache.invalidate(cache, listViewKey(view))))
        .then(() => setRefreshKey((value) => value + 1))
    } else if (key.name === "a") mutate("archive")
    else if (key.name === "d" || key.name === "delete" || key.name === "backspace") mutate("trash")
    else if (key.name === "m") mutate("read")
    else if (key.name === "x") mutate("unsubscribe")
  })

  const groupCounts = new Map<string, number>()
  for (const item of groupedMessages) {
    const id = String(item.account)
    groupCounts.set(id, (groupCounts.get(id) ?? 0) + 1)
  }
  const listEntries: Array<
    | { readonly type: "header"; readonly account: string; readonly count: number; readonly height: 1 }
    | { readonly type: "message"; readonly message: MailMessageSummary; readonly index: number; readonly height: 2 }
    | { readonly type: "spacer"; readonly key: string; readonly height: 1 }
  > = []
  let previousAccount: string | null = null
  groupedMessages.forEach((item, index) => {
    const id = String(item.account)
    if (account === "all" && id !== previousAccount) {
      if (previousAccount !== null) listEntries.push({ type: "spacer", key: `spacer-${id}`, height: 1 })
      listEntries.push({ type: "header", account: id, count: groupCounts.get(id) ?? 0, height: 1 })
      previousAccount = id
    }
    listEntries.push({ type: "message", message: item, index, height: 2 })
  })
  const selectedEntryIndex = listEntries.findIndex((entry) => entry.type === "message" && entry.index === selected)
  const selectedLine = listEntries
    .slice(0, Math.max(0, selectedEntryIndex))
    .reduce((total, entry) => total + entry.height, 0)
  const targetStartLine = Math.max(0, selectedLine - Math.floor(bodyHeight / 2))
  let startEntry = 0
  let consumedBefore = 0
  while (startEntry < listEntries.length) {
    const entry = listEntries[startEntry]
    if (!entry || consumedBefore + entry.height > targetStartLine) break
    consumedBefore += entry.height
    startEntry++
  }
  const visibleEntries: typeof listEntries = []
  let visibleHeight = 0
  for (const entry of listEntries.slice(startEntry)) {
    if (visibleHeight + entry.height > bodyHeight) break
    visibleEntries.push(entry)
    visibleHeight += entry.height
  }

  const listPane = (
    <box width={listWidth} height={bodyHeight} flexDirection="column">
      {loadState === "loading" ? <text fg={colors.muted}> Loading...</text> : null}
      {loadState === "error" ? <text fg={colors.error}>{`  ${notice}`}</text> : null}
      {loadState === "ready" && messages.length === 0 ? <text fg={colors.muted}> Inbox zero.</text> : null}
      {visibleEntries.map((entry) => {
        if (entry.type === "spacer") return <box key={entry.key} height={1} />
        if (entry.type === "header") {
          return (
            <box key={`header-${entry.account}`} height={1} paddingLeft={1} paddingRight={1}>
              <Line>
                <span fg={colors.count} attributes={TextAttributes.BOLD}>
                  {`${accountLabel(entry.account).toUpperCase()} · ${entry.count}`}
                </span>
              </Line>
            </box>
          )
        }

        const { message: item, index } = entry
        const active = index === selected
        const marker = item.unread ? "●" : " "
        const sender = oneLine(item.from || "Unknown sender")
        return (
          <box
            key={`${item.account}:${item.id}`}
            height={2}
            flexDirection="column"
            {...(active ? { backgroundColor: colors.selected } : {})}
          >
            <box height={1} paddingLeft={1} paddingRight={1}>
              <Line>
                <span fg={item.unread ? colors.accent : colors.muted}>{marker}</span>
                <span
                  fg={active ? colors.selectedText : colors.text}
                  attributes={item.unread ? TextAttributes.BOLD : 0}
                >
                  {truncate(` ${oneLine(item.subject)}`, Math.max(8, listWidth - 4))}
                </span>
              </Line>
            </box>
            <box height={1} paddingLeft={3} paddingRight={1}>
              <Line>
                <span fg={colors.muted}>{truncate(sender, Math.max(8, listWidth - 4))}</span>
              </Line>
            </box>
          </box>
        )
      })}
    </box>
  )

  const detailPane = (
    <box width={detailWidth} height={bodyHeight} flexDirection="column">
      {!selectedMessage ? (
        <box height={1} paddingLeft={1} paddingRight={1}>
          <text fg={colors.muted}>Select a message</text>
        </box>
      ) : null}
      {selectedMessage && detailState === "loading" ? (
        <box height={1} paddingLeft={1} paddingRight={1}>
          <text fg={colors.muted}>Loading message...</text>
        </box>
      ) : null}
      {selectedMessage && detailState === "error" ? (
        <box height={1} paddingLeft={1} paddingRight={1}>
          <text fg={colors.error}>{notice}</text>
        </box>
      ) : null}
      {message ? (
        <>
          <box height={1} paddingLeft={1} paddingRight={1}>
            <Line>
              <span fg={colors.text} attributes={TextAttributes.BOLD}>
                {oneLine(message.subject)}
              </span>
            </Line>
          </box>
          <box height={1} paddingLeft={1} paddingRight={1}>
            <Line>
              <span fg={colors.muted}>From </span>
              <span fg={colors.text}>{oneLine(message.from)}</span>
            </Line>
          </box>
          <box height={1} paddingLeft={1} paddingRight={1}>
            <Line>
              <span fg={colors.muted}>{message.date ?? ""}</span>
            </Line>
          </box>
          {message.attachments?.length ? (
            <box height={1} paddingLeft={1} paddingRight={1}>
              <Line>
                <span fg={colors.accent}>{`${message.attachments.length} attachment(s)`}</span>
              </Line>
            </box>
          ) : null}
          <Divider width={detailWidth} />
          <scrollbox flexGrow={1} paddingLeft={1} paddingRight={2} focused>
            {renderedBody?.format === "markdown" ? (
              <markdown
                content={renderedBody.content || "(No message body)"}
                syntaxStyle={markdownSyntaxStyle}
                fg={colors.text}
                conceal
              />
            ) : (
              <text fg={colors.text}>{renderedBody?.content || "(No message body)"}</text>
            )}
          </scrollbox>
        </>
      ) : null}
    </box>
  )

  return (
    <box width={width} height={height} flexDirection="column" backgroundColor={colors.background}>
      <box height={1} flexDirection="row" paddingLeft={1}>
        <box height={1}>
          <text wrapMode="none" truncate>
            <span fg={colors.accent} attributes={TextAttributes.BOLD}>
              {viewTitle}
            </span>
            {status === "unread" ? <span fg={colors.accent}> Unread</span> : null}
            <span fg={searching ? colors.accent : colors.muted}>
              {searching
                ? `  / ${searchDraft}_  `
                : query
                  ? `  ${query}${notice ? ` · ${notice}` : ""}  `
                  : `  ${notice || `${messages.length} ${messages.length === 1 ? "message" : "messages"}`}  `}
            </span>
          </text>
        </box>
        {accountChoices.map((id, index) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes are the clickable tab primitive
          <box
            key={id}
            height={1}
            onMouseDown={() => setAccount(id)}
            {...(id === account ? { backgroundColor: colors.selected } : {})}
          >
            {index > 0 ? <text> </text> : null}
            <text
              fg={id === account ? colors.selectedText : colors.muted}
              attributes={id === account ? TextAttributes.BOLD : 0}
            >
              {` ${accountLabel(id).toUpperCase()} `}
            </text>
          </box>
        ))}
      </box>
      <Divider width={width} junctions={compact ? [] : [{ at: listWidth, char: "┬" }]} />
      <box height={bodyHeight} flexDirection={compact ? "column" : "row"}>
        {!compact || !showDetail ? listPane : null}
        {!compact ? (
          <VerticalSeparator
            height={bodyHeight}
            junctions={detailDividerRow === null ? [] : [{ row: detailDividerRow, char: "├" }]}
          />
        ) : null}
        {!compact || showDetail ? detailPane : null}
      </box>
      <Divider width={width} junctions={compact ? [] : [{ at: listWidth, char: "┴" }]} />
      <box height={1} paddingLeft={1}>
        <Line>
          <span fg={colors.count}>?</span>
          <span fg={colors.muted}>{" help  "}</span>
          <span fg={colors.count}>/</span>
          <span fg={colors.muted}>{" search all mail  "}</span>
          <span fg={colors.count}>←/→</span>
          <span fg={colors.muted}>{" mailboxes  "}</span>
          <span fg={colors.count}>i</span>
          <span fg={colors.muted}> inbox/all</span>
        </Line>
      </box>
      {showShortcuts ? <ShortcutModal terminalWidth={width} terminalHeight={height} /> : null}
    </box>
  )
}

export const launchTui = async () => {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
    onDestroy: () => void runtime.dispose(),
  })
  installWindowFetch()
  createRoot(renderer).render(<MailApp />)
}
