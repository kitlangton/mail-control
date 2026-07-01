import { Effect, Exit, FileSystem, Path } from "effect"
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
import { combineGmailQuery, isOnOrAfter, parseDuration } from "./time.js"
import type { ListMailOptions, MailMessageBody, MailMessageSummary, MailStatus } from "./types.js"

export interface ListInput {
  readonly account: string
  readonly maxResults: number
  readonly status: MailStatus
  readonly query?: string
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

/** Gmail broadens beyond the inbox when searching; other types ignore the flag. */
const optionsFor = (account: ResolvedAccount, base: ListMailOptions, scope: "inbox" | "search"): ListMailOptions => ({
  ...base,
  ...(account.config.type === "gmail" && scope === "search" ? { inboxOnly: false } : {}),
})

const listForAccount = (account: ResolvedAccount, options: ListMailOptions) =>
  withAccount(account, (mail) => mail.listMessages(options))

const sortNewestFirst = (messages: readonly MailMessageSummary[]) =>
  [...messages].sort((a, b) => {
    const timeA = a.date ? Date.parse(a.date) : 0
    const timeB = b.date ? Date.parse(b.date) : 0
    return timeB - timeA
  })

export const mergeAccountListResults = (
  results: readonly Exit.Exit<readonly MailMessageSummary[], MailError>[],
  maxResults: number,
): Effect.Effect<readonly MailMessageSummary[], MailError> => {
  const messages = results.flatMap((result) => (Exit.isSuccess(result) ? result.value : []))

  if (messages.length === 0 && results.every((result) => Exit.isFailure(result))) {
    return Effect.fail(new MailError({ message: "Failed to list messages from every account." }))
  }

  return Effect.succeed(sortNewestFirst(messages).slice(0, maxResults))
}

export const listMessages = (input: ListInput): Effect.Effect<readonly MailMessageSummary[], MailError, AccountEnv> =>
  Effect.gen(function* () {
    const base = baseOptionsFrom(input)

    if (input.account !== "all") {
      const account = yield* requireAccount(input.account, "read", "Listing messages")
      return yield* listForAccount(account, optionsFor(account, base, input.scope))
    }

    const accounts = yield* Accounts
    const results = yield* Effect.forEach(
      accounts.all,
      (account) => Effect.exit(listForAccount(account, optionsFor(account, base, input.scope))),
      { concurrency: "unbounded" },
    )
    return yield* mergeAccountListResults(results, input.maxResults)
  })

export const recentMessages = (
  input: RecentInput,
): Effect.Effect<readonly MailMessageSummary[], MailError, AccountEnv> =>
  Effect.gen(function* () {
    const since = yield* parseDuration(input.since, "--since")
    const messages = yield* listMessages({
      account: input.account,
      maxResults: input.maxResults,
      status: input.status,
      scope: "search",
      query: combineGmailQuery(since.gmailNewerThan, input.query),
      ...(input.mailbox !== undefined ? { mailbox: input.mailbox } : {}),
    })

    return messages.filter((message) => isOnOrAfter(message.date, since.sinceDate))
  })

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
    const files = yield* Effect.all(
      attachments.map((attachment) =>
        Effect.gen(function* () {
          const filePath = pathService.join(input.outputDir, attachment.filename)
          yield* fs
            .writeFile(filePath, new Uint8Array(attachment.content))
            .pipe(
              Effect.mapError(
                (cause) => new MailError({ message: `Failed to write attachment ${attachment.filename}`, cause }),
              ),
            )
          return { filename: attachment.filename, path: filePath }
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
): Effect.Effect<"one-click" | "mailto", MailError, AccountEnv> =>
  Effect.gen(function* () {
    const account = yield* requireAccount(input.account, "unsubscribe", "Unsubscribe")
    return yield* withAccount(account, (mail) => mail.unsubscribeFromMessage(input.id))
  })
