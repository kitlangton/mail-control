import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, Layer, Option } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import type { AccountEnv } from "./account.js"
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
import { layer as accountsLayer } from "./config.js"
import { printDownloadResult, printJson, printMessage, printSummaries } from "./renderer.js"
import { layer as secretsLayer } from "./secrets.js"
import { envLayer } from "./support.js"
import { MailError, type MailStatus } from "./types.js"

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
  ]),
)

const cli = Command.runWith(root, {
  version: "0.2.0",
})

const platform = Layer.mergeAll(NodeServices.layer, envLayer())
const accounts = accountsLayer.pipe(Layer.provide(platform))
const secrets = secretsLayer.pipe(Layer.provide(platform), Layer.provide(accounts))
const configLayer = Layer.mergeAll(platform, accounts, secrets)

export const program = cli(process.argv.slice(2)).pipe(Effect.provide(configLayer))

if (import.meta.url === `file://${process.argv[1]}`) {
  NodeRuntime.runMain(program)
}
