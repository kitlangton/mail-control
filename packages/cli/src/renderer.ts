import { Console, Effect } from "effect"
import type { DownloadResult } from "./app.js"
import { createColorizer } from "./support.js"
import type { AccountId, MailMessageBody, MailMessageSummary } from "./types.js"

const { colorize } = createColorizer()
const dim = colorize(2)
const red = colorize(31)
const blue = colorize(34)
const gray = colorize(90)

const formatStatus = (status: "read" | "unread" | "unknown") => {
  const label = `[${status}]`
  if (status === "unread") return red(label)
  if (status === "read") return dim(label)
  return gray(label)
}

const formatAccount = (account: AccountId) => blue(`[${account}]`)

const statusOf = (message: { unread?: boolean }): "read" | "unread" | "unknown" =>
  message.unread === undefined ? "unknown" : message.unread ? "unread" : "read"

export const printJson = (value: unknown) => Console.log(JSON.stringify(value, null, 2))

export const printSummaries = (messages: readonly MailMessageSummary[]) =>
  Effect.gen(function* () {
    if (messages.length === 0) {
      yield* Console.log("No messages found.")
      return
    }

    for (const message of messages) {
      const status = statusOf(message)
      yield* Console.log(
        `• ${formatAccount(message.account)}${formatStatus(status)} ${message.subject} (${message.id})`,
      )
      if (message.from) {
        yield* Console.log(`  From: ${message.from}`)
      }
      if (message.date) {
        yield* Console.log(`  Date: ${message.date}`)
      }
      if (message.snippet) {
        yield* Console.log(`  Snippet: ${message.snippet}`)
      }
      yield* Console.log("")
    }
  })

export const printMessage = (message: MailMessageBody) =>
  Effect.gen(function* () {
    yield* Console.log(`${formatStatus(statusOf(message))} ${message.subject}`)
    yield* Console.log(`From: ${message.from}`)
    if (message.date) {
      yield* Console.log(`Date: ${message.date}`)
    }
    if (message.attachments && message.attachments.length > 0) {
      yield* Console.log(`Attachments: ${message.attachments.length}`)
      for (const attachment of message.attachments) {
        const sizeKb = (attachment.size / 1024).toFixed(1)
        yield* Console.log(`  - ${attachment.filename} (${attachment.mimeType}, ${sizeKb} KB)`)
      }
    }
    yield* Console.log("")
    yield* Console.log(message.body)
  })

export const printDownloadResult = (result: DownloadResult) =>
  Effect.gen(function* () {
    if (result.files.length === 0) {
      yield* Console.log("No attachments found on this message.")
      return
    }

    for (const file of result.files) {
      yield* Console.log(`Saved: ${file.path}`)
    }
    yield* Console.log(`Downloaded ${result.files.length} attachment(s)`)
  })
