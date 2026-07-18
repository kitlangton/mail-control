import { NodeRuntime } from "@effect/platform-node"
import { authorizeGmail } from "@mail-control/gmail"
import { Console, Effect, FileSystem, Option, Redacted } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { type AccountEnv, gmailAccountPaths, withAccount } from "./account.js"
import {
  archiveMessage,
  downloadAttachments,
  forwardMessage,
  listMessages,
  type MutationInput,
  markMessageRead,
  readMessage,
  recentMessages,
  replyToMessage,
  sendMessage,
  trashMessage,
  unsubscribeFromMessage,
} from "./app.js"
import { Accounts } from "./config.js"
import { MailError, toMailError } from "./errors.js"
import { makeICloudService } from "./icloud.js"
import { mailLayer } from "./layers.js"
import { printDownloadResult, printJson, printMessage, printSummaries } from "./renderer.js"
import { Secrets, writeAppPassword } from "./secrets.js"
import type { MailStatus } from "./types.js"

const accountOption = Flag.string("account").pipe(
  Flag.withAlias("a"),
  Flag.withDefault("all"),
  Flag.withDescription("Account id from your config.json, or 'all' (default) for read/list/search"),
)

const maxOption = Flag.integer("max").pipe(
  Flag.withAlias("m"),
  Flag.optional,
  Flag.withDescription("Maximum number of messages to list (default 10)"),
)

const queryOption = Flag.string("query").pipe(
  Flag.withAlias("q"),
  Flag.optional,
  Flag.withDescription("Optional search query"),
)
const unreadOption = Flag.boolean("unread").pipe(Flag.withDescription("Only show unread messages"))
const readOption = Flag.boolean("read").pipe(Flag.withDescription("Only show read messages"))
const jsonOption = Flag.boolean("json").pipe(Flag.withDescription("Print machine-readable JSON"))

const sinceOption = Flag.string("since").pipe(
  Flag.withDefault("24h"),
  Flag.withDescription("Lookback duration such as 24h, 2d, 6w, 12mo, or 1y"),
)

const mailboxOption = Flag.string("mailbox").pipe(
  Flag.optional,
  Flag.withDescription("Mailbox to query (iCloud only, default INBOX)"),
)

const toOption = Flag.string("to").pipe(
  Flag.withAlias("t"),
  Flag.atLeast(1),
  Flag.withDescription("Recipient email address (can be repeated: -t a@x.com -t b@x.com)"),
)
const subjectOption = Flag.string("subject").pipe(Flag.withAlias("s"), Flag.withDescription("Subject line"))
const bodyOption = Flag.string("body").pipe(
  Flag.withAlias("b"),
  Flag.optional,
  Flag.withDescription("Plain text email body"),
)
const bodyFileOption = Flag.file("body-file").pipe(
  Flag.withAlias("f"),
  Flag.optional,
  Flag.withDescription("Path to a text file containing the email body"),
)
const ccOption = Flag.string("cc").pipe(Flag.optional, Flag.withDescription("Optional CC recipients"))
const bccOption = Flag.string("bcc").pipe(Flag.optional, Flag.withDescription("Optional BCC recipients"))
const attachOption = Flag.file("attach").pipe(
  Flag.withAlias("A"),
  Flag.atLeast(0),
  Flag.withDescription("File(s) to attach (can be repeated)"),
)

const outputDirOption = Flag.directory("output").pipe(
  Flag.withAlias("o"),
  Flag.withDefault("."),
  Flag.withDescription("Directory to save attachments to (default: current directory)"),
)

const messageIdArg = Argument.string("message-id").pipe(Argument.withDescription("Message ID"))

const resolveStatus = (readFlag: boolean, unreadFlag: boolean): Effect.Effect<MailStatus, MailError> => {
  if (readFlag && unreadFlag) {
    return Effect.fail(new MailError({ message: "--read and --unread cannot both be specified" }))
  }
  if (readFlag) return Effect.succeed("read")
  if (unreadFlag) return Effect.succeed("unread")
  return Effect.succeed("all")
}

const maxResultsFrom = (max: Option.Option<number>) => Option.getOrElse(max, () => 10)
const opt = <A>(value: Option.Option<A>) => Option.getOrUndefined(value)

const gmailSetupGuide = (id: string, credentialsPath: string) =>
  [
    ``,
    `Gmail account "${id}" needs OAuth credentials before it can be authorized.`,
    ``,
    `  1. Open https://console.cloud.google.com/ and create or select a project.`,
    `  2. Enable the Gmail API:`,
    `       https://console.cloud.google.com/apis/library/gmail.googleapis.com`,
    `  3. Configure the OAuth consent screen (User type: External; add your`,
    `     Google address under "Test users").`,
    `  4. Credentials → Create credentials → OAuth client ID →`,
    `     Application type: "Desktop app".`,
    `  5. Download the JSON and save it to:`,
    `       ${credentialsPath}`,
    `  6. Re-run:  mail auth ${id}`,
    ``,
  ].join("\n")

/** Read a secret from the terminal without echoing it. */
const promptHidden = (prompt: string): Effect.Effect<string, MailError> =>
  Effect.callback<string, MailError>((resume) => {
    const stdin = process.stdin
    process.stdout.write(prompt)
    const wasRaw = stdin.isRaw ?? false
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.setEncoding("utf8")
    let buffer = ""
    const cleanup = () => {
      stdin.setRawMode?.(wasRaw)
      stdin.pause()
      stdin.removeListener("data", onData)
    }
    const onData = (char: string) => {
      if (char === "\n" || char === "\r" || char === "\u0004") {
        cleanup()
        process.stdout.write("\n")
        resume(Effect.succeed(buffer.trim()))
      } else if (char === "\u0003") {
        cleanup()
        process.stdout.write("\n")
        resume(Effect.fail(new MailError({ message: "Cancelled" })))
      } else if (char === "\u007f" || char === "\b") {
        buffer = buffer.slice(0, -1)
      } else {
        buffer += char
      }
    }
    stdin.on("data", onData)
    return Effect.sync(cleanup)
  })

/** Read all of piped stdin (for non-interactive `mail auth` on headless machines). */
const readAllStdin: Effect.Effect<string, MailError> = Effect.tryPromise({
  try: async () => {
    const chunks: string[] = []
    for await (const chunk of process.stdin) chunks.push(String(chunk))
    return chunks.join("").trim()
  },
  catch: (cause) => new MailError({ message: "Failed to read from stdin", cause }),
})

const listCommand = Command.make(
  "list",
  {
    account: accountOption,
    max: maxOption,
    query: queryOption,
    unread: unreadOption,
    read: readOption,
    mailbox: mailboxOption,
    json: jsonOption,
  },
  ({ account, max, query, unread, read, mailbox, json }) =>
    Effect.gen(function* () {
      const queryValue = opt(query)
      const mailboxValue = opt(mailbox)
      const messages = yield* listMessages({
        account,
        maxResults: maxResultsFrom(max),
        status: yield* resolveStatus(read, unread),
        scope: "inbox",
        ...(queryValue !== undefined ? { query: queryValue } : {}),
        ...(mailboxValue !== undefined ? { mailbox: mailboxValue } : {}),
      })
      yield* json ? printJson(messages) : printSummaries(messages)
    }),
)

const searchCommand = Command.make(
  "search",
  {
    account: accountOption,
    query: Argument.string("query").pipe(Argument.withDescription("Search query")),
    max: maxOption,
    unread: unreadOption,
    read: readOption,
    mailbox: mailboxOption,
    json: jsonOption,
  },
  ({ account, query, max, unread, read, mailbox, json }) =>
    Effect.gen(function* () {
      const mailboxValue = opt(mailbox)
      const messages = yield* listMessages({
        account,
        maxResults: maxResultsFrom(max),
        status: yield* resolveStatus(read, unread),
        query,
        scope: "search",
        ...(mailboxValue !== undefined ? { mailbox: mailboxValue } : {}),
      })
      yield* json ? printJson(messages) : printSummaries(messages)
    }),
)

const recentCommand = Command.make(
  "recent",
  {
    account: accountOption,
    since: sinceOption,
    max: maxOption,
    query: queryOption,
    unread: unreadOption,
    read: readOption,
    mailbox: mailboxOption,
    json: jsonOption,
  },
  ({ account, since, max, query, unread, read, mailbox, json }) =>
    Effect.gen(function* () {
      const queryValue = opt(query)
      const mailboxValue = opt(mailbox)
      const messages = yield* recentMessages({
        account,
        since,
        maxResults: maxResultsFrom(max),
        status: yield* resolveStatus(read, unread),
        ...(queryValue !== undefined ? { query: queryValue } : {}),
        ...(mailboxValue !== undefined ? { mailbox: mailboxValue } : {}),
      })
      yield* json ? printJson(messages) : printSummaries(messages)
    }),
)

const readCommand = Command.make(
  "read",
  {
    account: accountOption,
    id: Argument.string("id").pipe(Argument.withDescription("Message id")),
    mailbox: mailboxOption,
    json: jsonOption,
  },
  ({ account, id, mailbox, json }) =>
    Effect.gen(function* () {
      const mailboxValue = opt(mailbox)
      const message = yield* readMessage({
        account,
        id,
        ...(mailboxValue !== undefined ? { mailbox: mailboxValue } : {}),
      })
      yield* json ? printJson(message) : printMessage(message)
    }),
)

const sendCommand = Command.make(
  "send",
  {
    account: accountOption,
    to: toOption,
    subject: subjectOption,
    body: bodyOption,
    bodyFile: bodyFileOption,
    cc: ccOption,
    bcc: bccOption,
    attach: attachOption,
  },
  ({ account, to, subject, body, bodyFile, cc, bcc, attach }) =>
    Effect.gen(function* () {
      const bodyValue = opt(body)
      const bodyFileValue = opt(bodyFile)
      const ccValue = opt(cc)
      const bccValue = opt(bcc)
      yield* sendMessage({
        account,
        to,
        subject,
        attach,
        required: true,
        action: "send",
        ...(bodyValue !== undefined ? { body: bodyValue } : {}),
        ...(bodyFileValue !== undefined ? { bodyFile: bodyFileValue } : {}),
        ...(ccValue !== undefined ? { cc: ccValue } : {}),
        ...(bccValue !== undefined ? { bcc: bccValue } : {}),
      })
      yield* Console.log("✅ Message sent")
    }),
)

const replyCommand = Command.make(
  "reply",
  {
    account: accountOption,
    messageId: messageIdArg,
    body: bodyOption,
    bodyFile: bodyFileOption,
    cc: ccOption,
    bcc: bccOption,
    attach: attachOption,
  },
  ({ account, messageId, body, bodyFile, cc, bcc, attach }) =>
    Effect.gen(function* () {
      const bodyValue = opt(body)
      const bodyFileValue = opt(bodyFile)
      const ccValue = opt(cc)
      const bccValue = opt(bcc)
      yield* replyToMessage({
        account,
        messageId,
        attach,
        required: true,
        action: "reply",
        ...(bodyValue !== undefined ? { body: bodyValue } : {}),
        ...(bodyFileValue !== undefined ? { bodyFile: bodyFileValue } : {}),
        ...(ccValue !== undefined ? { cc: ccValue } : {}),
        ...(bccValue !== undefined ? { bcc: bccValue } : {}),
      })
      yield* Console.log("✅ Reply sent")
    }),
)

const forwardCommand = Command.make(
  "forward",
  {
    account: accountOption,
    messageId: messageIdArg,
    to: toOption,
    body: bodyOption,
    bodyFile: bodyFileOption,
    cc: ccOption,
    bcc: bccOption,
  },
  ({ account, messageId, to, body, bodyFile, cc, bcc }) =>
    Effect.gen(function* () {
      const bodyValue = opt(body)
      const bodyFileValue = opt(bodyFile)
      const ccValue = opt(cc)
      const bccValue = opt(bcc)
      yield* forwardMessage({
        account,
        messageId,
        to,
        required: false,
        action: "forward",
        ...(bodyValue !== undefined ? { body: bodyValue } : {}),
        ...(bodyFileValue !== undefined ? { bodyFile: bodyFileValue } : {}),
        ...(ccValue !== undefined ? { cc: ccValue } : {}),
        ...(bccValue !== undefined ? { bcc: bccValue } : {}),
      })
      yield* Console.log(`✅ Forwarded message ${messageId} to ${to.join(", ")}`)
    }),
)

const downloadCommand = Command.make(
  "download",
  {
    account: accountOption,
    id: Argument.string("id").pipe(Argument.withDescription("Message id")),
    outputDir: outputDirOption,
    json: jsonOption,
  },
  ({ account, id, outputDir, json }) =>
    Effect.gen(function* () {
      const result = yield* downloadAttachments({ account, id, outputDir })
      yield* json ? printJson(result) : printDownloadResult(result)
    }),
)

const mutationCommand = <A>(
  name: "archive" | "trash" | "mark-read" | "unsubscribe",
  description: string,
  run: (input: MutationInput) => Effect.Effect<A, MailError, AccountEnv>,
) =>
  Command.make(
    name,
    {
      account: accountOption,
      id: Argument.string("id").pipe(Argument.withDescription("Message id")),
      json: jsonOption,
    },
    ({ account, id, json }) =>
      Effect.gen(function* () {
        const result = yield* run({ account, id })
        if (json) {
          yield* printJson({ account, id, result })
          return
        }
        const detail = typeof result === "string" ? ` via ${result}` : ""
        yield* Console.log(`${description} message ${id}${detail}`)
      }),
  )

const archiveCommand = mutationCommand("archive", "Archived", archiveMessage)
const trashCommand = mutationCommand("trash", "Moved to trash", trashMessage)
const markReadCommand = mutationCommand("mark-read", "Marked read", markMessageRead)
const unsubscribeCommand = mutationCommand("unsubscribe", "Unsubscribed from", unsubscribeFromMessage)

const authCommand = Command.make(
  "auth",
  {
    account: Argument.string("account").pipe(Argument.withDescription("Account id from your config.json")),
    manual: Flag.boolean("manual").pipe(
      Flag.withDescription("Headless: print a URL and paste the code instead of opening a browser"),
    ),
  },
  ({ account, manual }) =>
    Effect.gen(function* () {
      const accounts = yield* Accounts
      const resolved = yield* accounts.get(account).pipe(Effect.mapError(toMailError))

      const config = resolved.config
      if (config.type === "gmail") {
        const fs = yield* FileSystem.FileSystem
        const paths = gmailAccountPaths(resolved.id, config, accounts.dir)
        const hasCredentials = yield* fs.exists(paths.credentialsPath).pipe(Effect.orElseSucceed(() => false))
        if (!hasCredentials) {
          yield* Console.log(gmailSetupGuide(resolved.id, paths.credentialsPath))
          return
        }
        yield* authorizeGmail({ credentialsPath: paths.credentialsPath, tokenPath: paths.tokenPath, manual }).pipe(
          Effect.mapError((cause) => new MailError({ message: `Authorization failed for "${resolved.id}"`, cause })),
        )
        yield* Console.log(`Token saved to ${paths.tokenPath}`)
        // The Gmail service reads the token file fresh, so verify via the normal path.
        yield* Console.log(`Verifying "${resolved.id}"...`)
        yield* withAccount(resolved, (mail) => mail.listMessages({ maxResults: 1 }))
      } else {
        yield* Console.log(
          `Create an app-specific password at https://appleid.apple.com (Sign-In and Security → App-Specific Passwords).`,
        )
        const password = process.stdin.isTTY
          ? yield* promptHidden(`App password for "${resolved.id}": `)
          : yield* readAllStdin
        if (password.length === 0) {
          return yield* Effect.fail(new MailError({ message: "No app password provided." }))
        }
        const secretsPath = yield* writeAppPassword(accounts.dir, resolved.id, password).pipe(
          Effect.mapError(toMailError),
        )
        yield* Console.log(`Saved app password to ${secretsPath}`)
        // The Secrets layer cached secrets.json at startup, so verify with the
        // password just entered rather than the now-stale cached lookup.
        yield* Console.log(`Verifying "${resolved.id}"...`)
        yield* makeICloudService(resolved.id, config, Redacted.make(password)).listMessages({ maxResults: 1 })
      }

      yield* Console.log(`✅ ${resolved.id} is ready`)
    }),
)

const accountsCommand = Command.make("accounts", {}, () =>
  Effect.gen(function* () {
    const accounts = yield* Accounts
    if (accounts.all.length === 0) {
      yield* Console.log("No accounts configured. Create ~/.mail-control/config.json (see config.example.json).")
      return
    }
    const fs = yield* FileSystem.FileSystem
    const secrets = yield* Secrets
    for (const account of accounts.all) {
      const status = yield* Effect.gen(function* () {
        if (account.config.type === "gmail") {
          const paths = gmailAccountPaths(account.id, account.config, accounts.dir)
          const hasCredentials = yield* fs.exists(paths.credentialsPath).pipe(Effect.orElseSucceed(() => false))
          const hasToken = yield* fs.exists(paths.tokenPath).pipe(Effect.orElseSucceed(() => false))
          if (hasCredentials && hasToken) return "ready"
          return hasCredentials
            ? `needs authorization (run: mail auth ${account.id})`
            : `needs credentials (run: mail auth ${account.id})`
        }
        const hasPassword = yield* secrets.appPassword(account).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
        return hasPassword ? "ready" : `needs app password (run: mail auth ${account.id})`
      })
      yield* Console.log(`${account.id.padEnd(14)} ${account.config.type.padEnd(7)} ${status}`)
    }
  }),
)

const tuiCommand = Command.make("tui", {}, () =>
  Effect.tryPromise({
    try: async () => {
      const { launchTui } = await import("./tui.js")
      await launchTui()
    },
    catch: (cause) => new MailError({ message: "Failed to launch TUI", cause }),
  }),
)

const root = Command.make("mail", {}).pipe(
  Command.withSubcommands([
    listCommand,
    searchCommand,
    recentCommand,
    readCommand,
    sendCommand,
    replyCommand,
    forwardCommand,
    downloadCommand,
    archiveCommand,
    trashCommand,
    markReadCommand,
    unsubscribeCommand,
    authCommand,
    accountsCommand,
    tuiCommand,
  ]),
)

const cli = Command.runWith(root, {
  version: "0.2.0",
})

// Print expected failures (bad account, missing config/token, provider errors)
// as a clean one-line message instead of a stack trace.
const reportFailure = (error: { readonly message: string }) =>
  Console.error(`mail: ${error.message}`).pipe(Effect.andThen(Effect.sync(() => (process.exitCode = 1))))

export const program = cli(process.argv.slice(2)).pipe(
  Effect.provide(mailLayer),
  Effect.catchTags({ MailError: reportFailure, MailConfigError: reportFailure }),
)

if (import.meta.url === `file://${process.argv[1]}`) {
  NodeRuntime.runMain(program)
}
