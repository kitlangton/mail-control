import { parseListUnsubscribe } from "@mail-control/gmail"
import { Effect, Redacted } from "effect"
import { ImapFlow } from "imapflow"
import nodemailer from "nodemailer"
import type { AccountId, ICloudAccountConfig } from "./config.js"
import { MailError, mailError } from "./errors.js"
import { parseDurationText } from "./time.js"
import type {
  Attachment,
  ListMailOptions,
  MailMessageBody,
  MailMessageSummary,
  ReadMailInput,
  SendMailInput,
} from "./types.js"

const IMAP_CONNECTION_TIMEOUT_MS = 15_000
const IMAP_GREETING_TIMEOUT_MS = 10_000
const IMAP_SOCKET_TIMEOUT_MS = 30_000
const UNSUBSCRIBE_TIMEOUT_MS = 15_000

const ICLOUD_KNOWN_FOLDERS = ["INBOX", "Archive", "Deleted Messages", "Sent Messages", "Drafts", "Junk"] as const
const ICLOUD_CAPABILITIES = ["UIDPLUS", "NAMESPACE", "CONDSTORE", "ESEARCH", "WITHIN", "ID"] as const

export type ICloudUnsubscribeMethod = "one-click" | "mailto" | "web"

export interface ICloudUnsubscribeResult {
  method: ICloudUnsubscribeMethod
  destination: string
}

export interface ICloudServiceInterface {
  readonly listMessages: (options?: ListMailOptions) => Effect.Effect<MailMessageSummary[], MailError>
  readonly readMessage: (input: ReadMailInput) => Effect.Effect<MailMessageBody, MailError>
  readonly sendEmail: (input: SendMailInput) => Effect.Effect<void, MailError>
  readonly archiveMessage: (messageId: string) => Effect.Effect<void, MailError>
  readonly trashMessage: (messageId: string) => Effect.Effect<void, MailError>
  readonly markMessageRead: (messageId: string) => Effect.Effect<void, MailError>
  readonly unsubscribeFromMessage: (messageId: string) => Effect.Effect<ICloudUnsubscribeResult, MailError>
}

/**
 * Parses a raw RFC 5322 header block (as returned by IMAP `headers` fetch) into
 * a name → value map, joining folded continuation lines.
 */
export const parseRawHeaders = (raw: string): Map<string, string> => {
  const unfolded = raw.replace(/\r\n[ \t]+/g, " ").split(/\r\n/)
  const headers = new Map<string, string>()
  for (const line of unfolded) {
    const separatorIndex = line.indexOf(":")
    if (separatorIndex === -1) continue
    const name = line.slice(0, separatorIndex).trim().toLowerCase()
    const value = line.slice(separatorIndex + 1).trim()
    if (name) headers.set(name, value)
  }
  return headers
}

export const findUnsubscribeUrl = (raw: string) => {
  const decoded = /content-transfer-encoding:\s*quoted-printable/i.test(raw)
    ? raw
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    : raw
  return decoded
    .replaceAll("&amp;", "&")
    .match(/https?:\/\/[^\s<>"']+/gi)
    ?.find((candidate) => candidate.toLowerCase().includes("unsub"))
}

interface ICloudConnection {
  readonly email: string
  readonly password: Redacted.Redacted<string>
  readonly imap: { readonly host: string; readonly port: number; readonly secure: boolean; readonly mailbox: string }
  readonly smtp: { readonly host: string; readonly port: number; readonly secure: boolean }
}

const connectionFrom = (account: ICloudAccountConfig, password: Redacted.Redacted<string>): ICloudConnection => ({
  email: account.email,
  password,
  imap: {
    host: account.imapHost ?? "imap.mail.me.com",
    port: account.imapPort ?? 993,
    secure: account.imapSecure ?? true,
    mailbox: account.mailbox ?? "INBOX",
  },
  smtp: {
    host: account.smtpHost ?? "smtp.mail.me.com",
    port: account.smtpPort ?? 587,
    secure: account.smtpSecure ?? false,
  },
})

const formatAddress = (name?: string, address?: string) => {
  if (!address) return name ?? ""
  if (!name) return address
  return `${name} <${address}>`
}

interface Envelope {
  subject?: string | undefined
  from?: { name?: string | undefined; address?: string | undefined }[] | undefined
  date?: Date | string | undefined
  messageId?: string | undefined
}

/** Shared envelope → display fields, used by both list and read. */
const envelopeFields = (envelope: Envelope | undefined, flags: Set<string> | undefined) => {
  const fromEntry = envelope?.from?.[0]
  return {
    subject: envelope?.subject ?? "(no subject)",
    from: formatAddress(fromEntry?.name, fromEntry?.address),
    ...(envelope?.date
      ? { date: typeof envelope.date === "string" ? envelope.date : envelope.date.toISOString() }
      : {}),
    ...(flags ? { unread: !flags.has("\\Seen") } : {}),
  }
}

const QUERY_TOKEN_PATTERN = /([a-z_]+):(?:"([^"]*)"|(\S*))|"([^"]+)"|(\S+)/gi

const parseOperatorDuration = (value: string, now: Date) => {
  const normalized = /^\d+\s*m$/i.test(value.trim()) ? `${value.trim()}o` : value
  return parseDurationText(normalized, now)
}

export const buildSearchCriteria = (options?: ListMailOptions, now = new Date()): Record<string, unknown> => {
  const status = options?.status ?? "all"
  const criteria: Record<string, unknown> = {}

  if (status === "unread") criteria.seen = false
  if (status === "read") criteria.seen = true
  if (options?.since) criteria.since = options.since

  const rawQuery = options?.query?.trim()
  if (!rawQuery) return criteria

  const fromValues: string[] = []
  const toValues: string[] = []
  const subjectValues: string[] = []
  const freeTerms: string[] = []

  for (const match of rawQuery.matchAll(QUERY_TOKEN_PATTERN)) {
    const key = match[1]?.toLowerCase()
    const val = match[2] ?? match[3] ?? ""
    const phrase = match[4] ?? match[5] ?? ""

    if (key !== undefined) {
      if (!val) {
        throw new MailError({ message: `Empty value for iCloud search operator "${key}:"` })
      }
      if (key === "from") {
        fromValues.push(val)
        continue
      }
      if (key === "to") {
        toValues.push(val)
        continue
      }
      if (key === "subject") {
        subjectValues.push(val)
        continue
      }
      if (key === "is") {
        const lower = val.toLowerCase()
        if (lower === "unread") {
          criteria.seen = false
          continue
        }
        if (lower === "read") {
          criteria.seen = true
          continue
        }
        throw new MailError({
          message: `Unsupported iCloud search operator "is:${val}" (supported: is:unread, is:read)`,
        })
      }
      if (key === "newer_than") {
        const parsed = parseOperatorDuration(val, now)
        if (!parsed) {
          throw new MailError({ message: `Invalid duration in iCloud search operator "newer_than:${val}"` })
        }
        criteria.since = parsed.sinceDate
        continue
      }
      if (key === "older_than") {
        const parsed = parseOperatorDuration(val, now)
        if (!parsed) {
          throw new MailError({ message: `Invalid duration in iCloud search operator "older_than:${val}"` })
        }
        criteria.before = parsed.sinceDate
        continue
      }
      throw new MailError({
        message: `Unsupported iCloud search operator "${key}:" (supported: from:, to:, subject:, is:unread, is:read, newer_than:, older_than:)`,
      })
    }

    if (phrase) {
      if (match[5] === "OR") continue
      freeTerms.push(phrase)
    }
  }

  const orClauses: Record<string, unknown>[][] = []

  if (toValues.length === 1) criteria.to = toValues[0]
  else if (toValues.length > 1) orClauses.push(toValues.map((to) => ({ to })))

  if (subjectValues.length === 1) criteria.subject = subjectValues[0]
  else if (subjectValues.length > 1) orClauses.push(subjectValues.map((subject) => ({ subject })))

  if (fromValues.length === 1) criteria.from = fromValues[0]
  else if (fromValues.length > 1) orClauses.push(fromValues.map((from) => ({ from })))

  if (freeTerms.length > 0) {
    const text = freeTerms.join(" ")
    orClauses.push([{ subject: text }, { from: text }])
  }

  if (orClauses.length === 1) {
    criteria.or = orClauses[0]
  } else if (orClauses.length > 1) {
    let combined = orClauses[0] ?? []
    for (const nextClause of orClauses.slice(1)) {
      combined = combined.map((existing) => ({ ...existing, or: nextClause }))
    }
    criteria.or = combined
  }

  return criteria
}

export const formatICloudMessageId = (mailbox: string, uid: number, defaultMailbox = "INBOX"): string =>
  mailbox === defaultMailbox ? String(uid) : `${mailbox}:${uid}`

export const parseICloudMessageId = (
  id: string,
  defaultMailbox = "INBOX",
): Effect.Effect<{ readonly mailbox: string; readonly uid: number }, MailError> => {
  const trimmed = id.trim()
  const colonIndex = trimmed.lastIndexOf(":")
  if (colonIndex > 0) {
    const mailbox = trimmed.slice(0, colonIndex).trim()
    const uid = Number(trimmed.slice(colonIndex + 1).trim())
    if (mailbox.length > 0 && Number.isSafeInteger(uid) && uid > 0) {
      return Effect.succeed({ mailbox, uid })
    }
    return Effect.fail(new MailError({ message: `Invalid iCloud message ID "${id}"` }))
  }
  const uid = Number(trimmed)
  return Number.isSafeInteger(uid) && uid > 0
    ? Effect.succeed({ mailbox: defaultMailbox, uid })
    : Effect.fail(new MailError({ message: `Invalid iCloud message ID "${id}"` }))
}

const toMailerAttachment = (attachment: Attachment) => ({
  filename: attachment.filename,
  content: Buffer.isBuffer(attachment.content) ? attachment.content : Buffer.from(attachment.content),
  contentType: attachment.mimeType,
})

/**
 * Builds an iCloud mail service for a single configured account. IMAP/SMTP
 * settings come from the account config (with sensible iCloud defaults) and the
 * app password is supplied already-resolved from the secrets chain.
 */
export const makeICloudService = (
  accountId: AccountId,
  account: ICloudAccountConfig,
  password: Redacted.Redacted<string>,
): ICloudServiceInterface => {
  const config = connectionFrom(account, password)

  const withClient = <A>(
    f: (client: ImapFlow, mailbox: string) => Effect.Effect<A, MailError>,
    options?: { readonly mailbox?: string; readonly readOnly?: boolean },
  ): Effect.Effect<A, MailError> => {
    const readOnly = options?.readOnly ?? false
    const targetMailbox = options?.mailbox ?? config.imap.mailbox
    return Effect.acquireUseRelease(
      Effect.tryPromise({
        try: async () => {
          const imap = new ImapFlow({
            host: config.imap.host,
            port: config.imap.port,
            secure: config.imap.secure,
            logger: false,
            disableAutoIdle: true,
            disableAutoEnable: true,
            disableCompression: true,
            connectionTimeout: IMAP_CONNECTION_TIMEOUT_MS,
            greetingTimeout: IMAP_GREETING_TIMEOUT_MS,
            socketTimeout: IMAP_SOCKET_TIMEOUT_MS,
            auth: { user: config.email, pass: Redacted.value(config.password), loginMethod: "LOGIN" },
          })
          // Skip redundant post-login CAPABILITY, ID, NAMESPACE, and LIST/LSUB round-trips on iCloud IMAP.
          const internal = imap as unknown as {
            state: unknown
            states: { AUTHENTICATED: unknown }
            authenticated: boolean
            expectCapabilityUpdate: boolean
            usable: boolean
            capabilities: Map<string, boolean | number>
            namespaces: unknown
            namespace: { prefix: string; delimiter: string }
            folders: Map<string, { path: string; delimiter: string }>
            upgradeToSTARTTLS: () => Promise<unknown>
            authenticate: () => Promise<unknown>
            setAuthenticationState: () => Promise<void>
            startSession: () => Promise<void>
          }
          if (
            config.imap.host === "imap.mail.me.com" &&
            config.imap.secure &&
            typeof internal.startSession === "function"
          ) {
            internal.setAuthenticationState = async function () {
              this.state = this.states.AUTHENTICATED
              this.authenticated = true
              this.expectCapabilityUpdate = false
              for (const cap of ICLOUD_CAPABILITIES) this.capabilities.set(cap, true)
              const personal = { prefix: "", delimiter: "/" }
              this.namespaces = { personal: [personal], other: false, shared: false }
              this.namespace = personal
              for (const folder of ICLOUD_KNOWN_FOLDERS) {
                this.folders.set(folder, { path: folder, delimiter: "/" })
              }
              this.folders.set(targetMailbox, { path: targetMailbox, delimiter: "/" })
            }
            internal.startSession = async function () {
              await this.upgradeToSTARTTLS()
              await this.authenticate()
              this.usable = true
            }
          }
          await imap.connect()
          return imap
        },
        catch: mailError("Failed to connect to iCloud IMAP"),
      }),
      (client) => f(client, targetMailbox),
      (client) =>
        Effect.promise(async () => {
          if (!readOnly) {
            await client.logout().catch(() => undefined)
          }
          client.close()
        }).pipe(Effect.ignore),
    )
  }

  const listMessages = (options?: ListMailOptions) =>
    Effect.gen(function* () {
      const criteria = yield* Effect.try({
        try: () => buildSearchCriteria(options),
        catch: mailError("Failed to list iCloud messages"),
      })
      const defaultBox = config.imap.mailbox
      const mailboxes =
        options?.mailbox !== undefined
          ? [options.mailbox]
          : options?.inboxOnly === false && defaultBox !== "Archive"
            ? [defaultBox, "Archive"]
            : [defaultBox]

      return yield* withClient(
        (client) =>
          Effect.tryPromise({
            try: async () => {
              const limit = options?.maxResults ?? 10
              if (limit <= 0) return []
              const seenMessageIds = new Set<string>()
              const collected: { summary: MailMessageSummary; uid: number }[] = []

              for (const boxName of mailboxes) {
                const box = await client.mailboxOpen(boxName, { readOnly: true })
                if (box.exists === 0) continue

                const results = await client.search(criteria as Parameters<ImapFlow["search"]>[0], {
                  uid: true,
                })
                if (results === false) {
                  throw new Error(`IMAP search failed in mailbox "${boxName}"`)
                }
                const ids = Array.isArray(results) ? results : []
                if (ids.length === 0) continue
                const target = [...ids].sort((a, b) => a - b).slice(-limit)

                const boxSummaries: {
                  summary: MailMessageSummary
                  uid: number
                  messageId?: string | undefined
                }[] = []
                for await (const rawMessage of client.fetch(target, { envelope: true, flags: true }, { uid: true })) {
                  const message = rawMessage as { uid: number; envelope?: Envelope; flags?: Set<string> }
                  boxSummaries.push({
                    uid: message.uid,
                    messageId: message.envelope?.messageId,
                    summary: {
                      account: accountId,
                      id: formatICloudMessageId(boxName, message.uid, defaultBox),
                      snippet: "",
                      ...envelopeFields(message.envelope, message.flags),
                    },
                  })
                }

                for (const item of boxSummaries.reverse()) {
                  const msgId = item.messageId?.trim()
                  if (msgId) {
                    if (seenMessageIds.has(msgId)) continue
                    seenMessageIds.add(msgId)
                  }
                  collected.push({ summary: item.summary, uid: item.uid })
                }
              }

              if (mailboxes.length > 1) {
                collected.sort((a, b) => {
                  const timeA = a.summary.date ? Date.parse(a.summary.date) : 0
                  const timeB = b.summary.date ? Date.parse(b.summary.date) : 0
                  return timeB !== timeA ? timeB - timeA : b.uid - a.uid
                })
              }

              return collected.slice(0, limit).map((item) => item.summary)
            },
            catch: mailError("Failed to list iCloud messages"),
          }),
        { ...(options?.mailbox !== undefined ? { mailbox: options.mailbox } : {}), readOnly: true },
      )
    })

  const readMessage = (input: ReadMailInput) =>
    Effect.gen(function* () {
      const defaultBox = config.imap.mailbox
      const { mailbox, uid } = yield* parseICloudMessageId(input.id, input.mailbox ?? defaultBox)
      return yield* withClient(
        (client, targetMailbox) =>
          Effect.tryPromise({
            try: async () => {
              await client.mailboxOpen(targetMailbox, { readOnly: true })
              const rawMessage = await client.fetchOne(
                uid,
                { envelope: true, flags: true, bodyParts: ["TEXT"] },
                { uid: true },
              )
              if (!rawMessage) return undefined
              const bodyBuffer = rawMessage.bodyParts?.get("TEXT") ?? rawMessage.bodyParts?.values().next().value
              return {
                id: formatICloudMessageId(targetMailbox, rawMessage.uid, defaultBox),
                ...envelopeFields(rawMessage.envelope, rawMessage.flags),
                body: bodyBuffer ? bodyBuffer.toString("utf8") : "",
              } satisfies MailMessageBody
            },
            catch: mailError("Failed to read iCloud message"),
          }).pipe(
            Effect.flatMap((message) =>
              message === undefined
                ? Effect.fail(new MailError({ message: `No iCloud message found with id ${input.id}` }))
                : Effect.succeed(message),
            ),
          ),
        { mailbox, readOnly: true },
      )
    })

  const sendEmail = (input: SendMailInput) =>
    Effect.tryPromise({
      try: async () => {
        const transporter = nodemailer.createTransport({
          host: config.smtp.host,
          port: config.smtp.port,
          secure: config.smtp.secure,
          connectionTimeout: IMAP_CONNECTION_TIMEOUT_MS,
          greetingTimeout: IMAP_GREETING_TIMEOUT_MS,
          auth: { user: config.email, pass: Redacted.value(config.password) },
        })
        await transporter.sendMail({
          from: config.email,
          to: input.to,
          subject: input.subject,
          text: input.body,
          cc: input.cc,
          bcc: input.bcc,
          ...(input.attachments ? { attachments: input.attachments.map(toMailerAttachment) } : {}),
        })
      },
      catch: mailError("Failed to send iCloud email"),
    })

  const moveToSpecialUse = (messageId: string, specialUse: "\\Archive" | "\\Trash", fallback: string, verb: string) =>
    Effect.gen(function* () {
      const { mailbox, uid } = yield* parseICloudMessageId(messageId, config.imap.mailbox)
      yield* withClient(
        (client, targetMailbox) =>
          Effect.tryPromise({
            try: async () => {
              await client.mailboxOpen(targetMailbox)
              const existing = await client.fetchOne(uid, { uid: true }, { uid: true })
              if (!existing) {
                throw new Error(`No iCloud message found with id ${messageId}`)
              }
              const mailboxes = await client.list()
              const destination = mailboxes.find((candidate) => candidate.specialUse === specialUse)?.path ?? fallback
              if (destination === targetMailbox) return
              const moved = await client.messageMove({ uid }, destination, { uid: true })
              if (
                !moved ||
                (typeof moved === "object" &&
                  "uidMap" in moved &&
                  moved.uidMap instanceof Map &&
                  moved.uidMap.size === 0)
              ) {
                throw new Error(`No iCloud message moved for id ${messageId}`)
              }
            },
            catch: mailError(`Failed to ${verb} iCloud message ${messageId}`),
          }),
        { mailbox },
      )
    })

  const archiveMessage = (messageId: string) => moveToSpecialUse(messageId, "\\Archive", "Archive", "archive")
  const trashMessage = (messageId: string) =>
    moveToSpecialUse(messageId, "\\Trash", "Deleted Messages", "move to trash")

  const markMessageRead = (messageId: string) =>
    Effect.gen(function* () {
      const { mailbox, uid } = yield* parseICloudMessageId(messageId, config.imap.mailbox)
      yield* withClient(
        (client, targetMailbox) =>
          Effect.tryPromise({
            try: async () => {
              await client.mailboxOpen(targetMailbox)
              const existing = await client.fetchOne(uid, { uid: true }, { uid: true })
              if (!existing) {
                throw new Error(`No iCloud message found with id ${messageId}`)
              }
              const updated = await client.messageFlagsAdd({ uid }, ["\\Seen"], { uid: true })
              if (!updated) {
                throw new Error(`Failed to update flags for iCloud message ${messageId}`)
              }
            },
            catch: mailError(`Failed to mark iCloud message ${messageId} read`),
          }),
        { mailbox },
      )
    })

  const unsubscribeFromMessage = (messageId: string): Effect.Effect<ICloudUnsubscribeResult, MailError> =>
    Effect.gen(function* () {
      const { mailbox, uid } = yield* parseICloudMessageId(messageId, config.imap.mailbox)
      const message = yield* withClient(
        (client, targetMailbox) =>
          Effect.tryPromise({
            try: async () => {
              await client.mailboxOpen(targetMailbox, { readOnly: true })
              const message = await client.fetchOne(
                uid,
                { headers: ["List-Unsubscribe", "List-Unsubscribe-Post"], bodyParts: ["TEXT"] },
                { uid: true },
              )
              if (!message) return undefined
              const body = message.bodyParts?.get("TEXT") ?? message.bodyParts?.values().next().value
              return {
                headers: message.headers?.toString("utf8") ?? "",
                body: body?.toString("utf8") ?? "",
              }
            },
            catch: mailError(`Failed to retrieve unsubscribe headers for iCloud message ${messageId}`),
          }),
        { mailbox, readOnly: true },
      )

      if (message === undefined) {
        return yield* Effect.fail(new MailError({ message: `No iCloud message found with id ${messageId}` }))
      }

      const headers = parseRawHeaders(message.headers)
      const listUnsubscribe = headers.get("list-unsubscribe")
      const destinations = listUnsubscribe ? parseListUnsubscribe(listUnsubscribe) : []
      const oneClick = headers.get("list-unsubscribe-post")?.toLowerCase().includes("list-unsubscribe=one-click")
      const httpsDestination = destinations.find((destination) => destination.protocol === "https:")

      if (oneClick && httpsDestination) {
        yield* Effect.tryPromise({
          try: async () => {
            const response = await fetch(httpsDestination, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: "List-Unsubscribe=One-Click",
              redirect: "follow",
              signal: AbortSignal.timeout(UNSUBSCRIBE_TIMEOUT_MS),
            })
            if (!response.ok) {
              throw new Error(`HTTP ${response.status} ${response.statusText}`)
            }
          },
          catch: (cause) => new MailError({ message: `One-click unsubscribe failed for message ${messageId}`, cause }),
        })
        return { method: "one-click", destination: httpsDestination.toString() }
      }

      const mailtoDestination = destinations.find((destination) => destination.protocol === "mailto:")
      if (mailtoDestination) {
        const to = decodeURIComponent(mailtoDestination.pathname)
        if (!to) {
          return yield* Effect.fail(
            new MailError({ message: `Message ${messageId} has an invalid mailto unsubscribe` }),
          )
        }
        yield* sendEmail({
          to,
          subject: mailtoDestination.searchParams.get("subject") ?? "unsubscribe",
          body: mailtoDestination.searchParams.get("body") ?? "unsubscribe",
        })
        return { method: "mailto", destination: to }
      }

      const webDestination = httpsDestination?.toString() ?? findUnsubscribeUrl(message.body)
      if (webDestination) {
        yield* Effect.tryPromise({
          try: async () => {
            const response = await fetch(webDestination, {
              redirect: "follow",
              signal: AbortSignal.timeout(UNSUBSCRIBE_TIMEOUT_MS),
            })
            if (!response.ok) {
              throw new Error(`HTTP ${response.status} ${response.statusText}`)
            }
          },
          catch: (cause) => new MailError({ message: `Web unsubscribe failed for message ${messageId}`, cause }),
        })
        return { method: "web", destination: webDestination }
      }

      return yield* Effect.fail(
        new MailError({
          message: `Message ${messageId} does not provide an actionable unsubscribe option`,
        }),
      )
    })

  return {
    listMessages,
    readMessage,
    sendEmail,
    archiveMessage,
    trashMessage,
    markMessageRead,
    unsubscribeFromMessage,
  }
}
