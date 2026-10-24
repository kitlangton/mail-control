import path from "node:path"
import { Cause, Effect, Exit, FileSystem, Option, Path } from "effect"
import { type AccountEnv, requireAccount, withAccount } from "./account.js"
import {
  type ForwardComposeInput,
  makeForwardInput,
  makeReplyInput,
  makeSendInput,
  type ReplyComposeInput,
  type SendComposeInput,
} from "./compose.js"
import { Accounts, type ResolvedAccount } from "./config.js"
import { MailError } from "./errors.js"
import { combineGmailQuery, type DurationWindow, isOnOrAfter, parseDuration } from "./time.js"
import type { ListMailOptions, MailMessageBody, MailMessageSummary, MailStatus } from "./types.js"

export interface ListInput {
  readonly account: string
  readonly maxResults: number
  readonly status: MailStatus
  readonly query?: string
  readonly since?: DurationWindow
  readonly mailbox?: string
  readonly scope: "inbox" | "search"
}

export interface ReadInput {
  readonly account: string
  readonly id: string
  readonly mailbox?: string
}

export interface AccountComposeInput extends SendComposeInput {
  readonly account: string
}

export interface AccountReplyInput extends ReplyComposeInput {
  readonly account: string
}

export interface AccountForwardInput extends ForwardComposeInput {
  readonly account: string
}

export interface DownloadInput {
  readonly account: string
  readonly id: string
  readonly outputDir: string
}

export interface MutationInput {
  readonly account: string
  readonly id: string
}

export interface RecentInput {
  readonly account: string
  readonly since: string
  readonly maxResults: number
  readonly status: MailStatus
  readonly query?: string
  readonly mailbox?: string
}

export interface DownloadResult {
  readonly files: readonly {
    readonly filename: string
    readonly path: string
  }[]
}

const baseOptionsFrom = (input: ListInput): ListMailOptions => ({
  maxResults: input.maxResults,
  status: input.status,
  ...(input.query !== undefined ? { query: input.query } : {}),
  ...(input.mailbox !== undefined ? { mailbox: input.mailbox } : {}),
})

/** Gmail broadens beyond the inbox when searching and uses `newer_than:Xd`; iCloud uses `since: Date`. */
const optionsFor = (
  account: ResolvedAccount,
  base: ListMailOptions,
  scope: "inbox" | "search",
  since?: DurationWindow,
): ListMailOptions => {
  if (account.config.type === "gmail") {
    const query = since ? combineGmailQuery(since.gmailNewerThan, base.query) : base.query
    return {
      ...base,
      ...(query !== undefined && query.length > 0 ? { query } : {}),
      ...(scope === "search" ? { inboxOnly: false } : {}),
    }
  }
  return {
    ...base,
    ...(since !== undefined ? { since: since.sinceDate } : {}),
    ...(scope === "search" && base.mailbox === undefined ? { inboxOnly: false } : {}),
  }
}

const listForAccount = (account: ResolvedAccount, options: ListMailOptions) =>
  withAccount(account, (mail) => mail.listMessages(options))

const sortNewestFirst = (messages: readonly MailMessageSummary[]) =>
  [...messages].sort((a, b) => {
    const timeA = a.date ? Date.parse(a.date) : 0
    const timeB = b.date ? Date.parse(b.date) : 0
    return timeB - timeA
  })

export interface ListReport {
  readonly messages: readonly MailMessageSummary[]
  /** One line per account that failed, e.g. `icloud: Sign in again: run mail auth icloud`. */
  readonly warnings: readonly string[]
}

export interface AccountListResult {
  readonly account: string
  readonly exit: Exit.Exit<readonly MailMessageSummary[], MailError>
}

/** Keep the accounts that answered, but report each failed account instead of dropping it silently. */
export const mergeAccountListResults = (
  results: readonly AccountListResult[],
  maxResults: number,
): Effect.Effect<ListReport, MailError> => {
  const messages = results.flatMap(({ exit }) => (Exit.isSuccess(exit) ? exit.value : []))
  const warnings = results.flatMap(({ account, exit }) =>
    Exit.isFailure(exit) ? [`${account}: ${failureMessage(exit)}`] : [],
  )

  if (results.length > 0 && warnings.length === results.length) {
    return Effect.fail(
      new MailError({ message: `Failed to list messages from every account (${warnings.join("; ")})` }),
    )
  }

  return Effect.succeed({ messages: sortNewestFirst(messages).slice(0, maxResults), warnings })
}

const failureMessage = (exit: Exit.Exit<unknown, MailError>) =>
  Exit.isFailure(exit)
    ? Option.match(Cause.findErrorOption(exit.cause), {
        onNone: () => "unexpected failure",
        onSome: (error) => error.message,
      })
    : ""

export const listMessagesReport = (input: ListInput): Effect.Effect<ListReport, MailError, AccountEnv> =>
  Effect.gen(function* () {
    const base = baseOptionsFrom(input)

    if (input.account !== "all") {
      const account = yield* requireAccount(input.account, "read", "Listing messages")
      return {
        messages: yield* listForAccount(account, optionsFor(account, base, input.scope, input.since)),
        warnings: [],
      }
    }

    const accounts = yield* Accounts
    const results = yield* Effect.forEach(
      accounts.all,
      (account) =>
        Effect.exit(listForAccount(account, optionsFor(account, base, input.scope, input.since))).pipe(
          Effect.map((exit) => ({ account: account.id, exit })),
        ),
      { concurrency: "unbounded" },
    )
    return yield* mergeAccountListResults(results, input.maxResults)
  })

export const listMessages = (input: ListInput): Effect.Effect<readonly MailMessageSummary[], MailError, AccountEnv> =>
  listMessagesReport(input).pipe(Effect.map((report) => report.messages))

export const recentMessagesReport = (input: RecentInput): Effect.Effect<ListReport, MailError, AccountEnv> =>
  Effect.gen(function* () {
    const since = yield* parseDuration(input.since, "--since")
    const report = yield* listMessagesReport({
      account: input.account,
      maxResults: input.maxResults,
      status: input.status,
      scope: "search",
      since,
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.mailbox !== undefined ? { mailbox: input.mailbox } : {}),
    })

    return { ...report, messages: report.messages.filter((message) => isOnOrAfter(message.date, since.sinceDate)) }
  })

export const recentMessages = (
  input: RecentInput,
): Effect.Effect<readonly MailMessageSummary[], MailError, AccountEnv> =>
  recentMessagesReport(input).pipe(Effect.map((report) => report.messages))

export const readMessage = (input: ReadInput): Effect.Effect<MailMessageBody, MailError, AccountEnv> =>
  Effect.gen(function* () {
    const account = yield* requireAccount(input.account, "read", "Reading a message")
    return yield* withAccount(account, (mail) =>
      mail.readMessage({
        id: input.id,
        ...(input.mailbox !== undefined ? { mailbox: input.mailbox } : {}),
      }),
    )
  })

export const sendMessage = (
  input: AccountComposeInput,
): Effect.Effect<void, MailError, AccountEnv | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const account = yield* requireAccount(input.account, "send", "Sending")
    const sendInput = yield* makeSendInput(input)
    return yield* withAccount(account, (mail) => mail.sendEmail(sendInput))
  })

export const replyToMessage = (
  input: AccountReplyInput,
): Effect.Effect<void, MailError, AccountEnv | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const account = yield* requireAccount(input.account, "reply", "Replying")
    const replyInput = yield* makeReplyInput(input)
    return yield* withAccount(account, (mail) => mail.replyToEmail(replyInput))
  })

export const forwardMessage = (
  input: AccountForwardInput,
): Effect.Effect<void, MailError, AccountEnv | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const account = yield* requireAccount(input.account, "forward", "Forwarding")
    return yield* withAccount(account, (mail) =>
      Effect.gen(function* () {
        const original = yield* mail.readMessage({ id: input.messageId })
        const downloaded = yield* mail.downloadAttachments(input.messageId)
        const sendInput = yield* makeForwardInput(input, original, downloaded)
        yield* mail.sendEmail(sendInput)
      }),
    )
  })

export const sanitizeAttachmentFilename = (raw: string, index = 0): string => {
  const leaf = Array.from(path.posix.basename(raw.replaceAll("\\", "/")), (ch) => {
    const code = ch.charCodeAt(0)
    return code <= 0x1f || code === 0x7f ? "_" : ch
  })
    .join("")
    .trim()
  if (!leaf || leaf === "." || leaf === "..") {
    return `attachment-${index + 1}`
  }
  return leaf
}

const dedupeFilename = (name: string, used: Set<string>): string => {
  if (!used.has(name)) {
    used.add(name)
    return name
  }
  const ext = path.posix.extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  let counter = 2
  while (used.has(`${stem}-${counter}${ext}`)) counter++
  const candidate = `${stem}-${counter}${ext}`
  used.add(candidate)
  return candidate
}

export const downloadAttachments = (
  input: DownloadInput,
): Effect.Effect<DownloadResult, MailError, AccountEnv | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const account = yield* requireAccount(input.account, "downloadAttachments", "Downloading attachments")
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    const attachments = yield* withAccount(account, (mail) => mail.downloadAttachments(input.id))

    if (attachments.length === 0) {
      return { files: [] }
    }

    yield* fs.makeDirectory(input.outputDir, { recursive: true }).pipe(Effect.ignore)
    const usedNames = new Set<string>()
    const files = yield* Effect.all(
      attachments.map((attachment, index) =>
        Effect.gen(function* () {
          const safeFilename = dedupeFilename(sanitizeAttachmentFilename(attachment.filename, index), usedNames)
          const filePath = pathService.join(input.outputDir, safeFilename)
          yield* fs
            .writeFile(filePath, new Uint8Array(attachment.content))
            .pipe(
              Effect.mapError(
                (cause) => new MailError({ message: `Failed to write attachment ${safeFilename}`, cause }),
              ),
            )
          return { filename: safeFilename, path: filePath }
        }),
      ),
    )
    return { files }
  })

export const archiveMessage = (input: MutationInput): Effect.Effect<void, MailError, AccountEnv> =>
  Effect.gen(function* () {
    const account = yield* requireAccount(input.account, "archive", "Archiving")
    return yield* withAccount(account, (mail) => mail.archiveMessage(input.id))
  })

export const trashMessage = (input: MutationInput): Effect.Effect<void, MailError, AccountEnv> =>
  Effect.gen(function* () {
    const account = yield* requireAccount(input.account, "trash", "Trash")
    return yield* withAccount(account, (mail) => mail.trashMessage(input.id))
  })

export const markMessageRead = (input: MutationInput): Effect.Effect<void, MailError, AccountEnv> =>
  Effect.gen(function* () {
    const account = yield* requireAccount(input.account, "markRead", "Mark read")
    return yield* withAccount(account, (mail) => mail.markMessageRead(input.id))
  })

export const unsubscribeFromMessage = (
  input: MutationInput,
): Effect.Effect<"one-click" | "mailto" | "web", MailError, AccountEnv> =>
  Effect.gen(function* () {
    const account = yield* requireAccount(input.account, "unsubscribe", "Unsubscribe")
    return yield* withAccount(account, (mail) => mail.unsubscribeFromMessage(input.id))
  })
