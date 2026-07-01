import type { GmailMessageBody, GmailMessageSummary, GmailServiceInterface } from "@mail-control/gmail"
import { Context, Effect } from "effect"
import type { AccountId } from "./config.js"
import { MailError, mailError } from "./errors.js"
import type { ICloudServiceInterface } from "./icloud.js"
import type {
  ListMailOptions,
  MailMessageBody,
  MailMessageSummary,
  ReadMailInput,
  ReplyMailInput,
  SendMailInput,
} from "./types.js"

export interface DownloadedAttachment {
  filename: string
  mimeType: string
  content: Buffer
}

export class MailService extends Context.Service<
  MailService,
  {
    readonly listMessages: (options?: ListMailOptions) => Effect.Effect<readonly MailMessageSummary[], MailError>
    readonly readMessage: (input: ReadMailInput) => Effect.Effect<MailMessageBody, MailError>
    readonly sendEmail: (input: SendMailInput) => Effect.Effect<void, MailError>
    readonly replyToEmail: (input: ReplyMailInput) => Effect.Effect<void, MailError>
    readonly downloadAttachments: (messageId: string) => Effect.Effect<readonly DownloadedAttachment[], MailError>
    readonly archiveMessage: (messageId: string) => Effect.Effect<void, MailError>
    readonly trashMessage: (messageId: string) => Effect.Effect<void, MailError>
    readonly markMessageRead: (messageId: string) => Effect.Effect<void, MailError>
    readonly unsubscribeFromMessage: (messageId: string) => Effect.Effect<"one-click" | "mailto", MailError>
  }
>()("@mail-control/MailService") {}

const toMailSummary = (account: AccountId, message: GmailMessageSummary): MailMessageSummary => ({
  account,
  id: message.id,
  subject: message.subject,
  from: message.from,
  ...(message.date !== undefined ? { date: message.date } : {}),
  ...(message.snippet !== undefined ? { snippet: message.snippet } : {}),
  ...(message.unread !== undefined ? { unread: message.unread } : {}),
})

const toMailBody = (message: GmailMessageBody): MailMessageBody => ({
  id: message.id,
  subject: message.subject,
  from: message.from,
  body: message.body,
  ...(message.htmlBody !== undefined ? { htmlBody: message.htmlBody } : {}),
  ...(message.date !== undefined ? { date: message.date } : {}),
  ...(message.unread !== undefined ? { unread: message.unread } : {}),
  ...(message.attachments.length > 0
    ? {
        attachments: message.attachments.map((a) => ({
          id: a.id,
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
        })),
      }
    : {}),
})

export const makeGmailMailService = (account: AccountId, gmail: GmailServiceInterface) => {
  const listMessages = (options?: ListMailOptions) =>
    Effect.gen(function* () {
      const status = options?.status ?? "all"
      const queryParts: string[] = []

      if (status === "unread") queryParts.push("is:unread")
      if (status === "read") queryParts.push("is:read")
      if (options?.query) queryParts.push(options.query)

      const query = queryParts.length > 0 ? queryParts.join(" ") : undefined

      const gmailOptions: Parameters<typeof gmail.listMessages>[0] = {
        maxResults: options?.maxResults ?? 10,
        ...(options?.inboxOnly === false ? {} : { labelIds: ["INBOX"] }),
        ...(query !== undefined ? { query } : {}),
      }
      const messages = yield* gmail.listMessages(gmailOptions)

      return messages.map((message) => toMailSummary(account, message))
    }).pipe(Effect.mapError(mailError("Failed to list Gmail messages")))

  const readMessage = (input: ReadMailInput) =>
    gmail.readMessage(input.id).pipe(
      Effect.map((message) => toMailBody(message)),
      Effect.mapError(mailError("Failed to read Gmail message")),
    )

  const sendEmail = (input: SendMailInput) =>
    gmail.sendEmail(input).pipe(Effect.asVoid, Effect.mapError(mailError("Failed to send Gmail message")))

  const replyToEmail = (input: ReplyMailInput) =>
    gmail.replyToEmail(input).pipe(Effect.asVoid, Effect.mapError(mailError("Failed to reply to Gmail message")))

  const downloadAttachments = (messageId: string) =>
    Effect.gen(function* () {
      const message = yield* gmail.readMessage(messageId)
      if (message.attachments.length === 0) return [] as const

      return yield* Effect.all(
        message.attachments.map((att) =>
          gmail
            .getAttachment(messageId, att.id)
            .pipe(Effect.map((content) => ({ filename: att.filename, mimeType: att.mimeType, content }))),
        ),
        { concurrency: 3 },
      )
    }).pipe(Effect.mapError(mailError("Failed to download Gmail attachments")))

  const archiveMessage = (messageId: string) =>
    gmail.archiveMessage(messageId).pipe(Effect.mapError(mailError("Failed to archive Gmail message")))

  const trashMessage = (messageId: string) =>
    gmail.trashMessage(messageId).pipe(Effect.mapError(mailError("Failed to move Gmail message to trash")))

  const markMessageRead = (messageId: string) =>
    gmail.markMessageRead(messageId).pipe(Effect.mapError(mailError("Failed to mark Gmail message read")))

  const unsubscribeFromMessage = (messageId: string) =>
    gmail.unsubscribeFromMessage(messageId).pipe(
      Effect.map((result) => result.method),
      Effect.mapError(mailError("Failed to unsubscribe from Gmail message")),
    )

  return MailService.of({
    listMessages,
    readMessage,
    sendEmail,
    replyToEmail,
    downloadAttachments,
    archiveMessage,
    trashMessage,
    markMessageRead,
    unsubscribeFromMessage,
  })
}

const icloudUnsupported = (capability: string) =>
  Effect.fail(new MailError({ message: `${capability} is not supported for iCloud accounts.` }))

// iCloud already returns MailError with specific messages, so this adapter just
// widens it to the unified surface and stubs the capabilities iCloud lacks.
export const makeICloudMailService = (icloud: ICloudServiceInterface) =>
  MailService.of({
    listMessages: icloud.listMessages,
    readMessage: icloud.readMessage,
    sendEmail: icloud.sendEmail,
    archiveMessage: icloud.archiveMessage,
    trashMessage: icloud.trashMessage,
    replyToEmail: () => icloudUnsupported("Reply"),
    downloadAttachments: () => icloudUnsupported("Attachment download"),
    markMessageRead: () => icloudUnsupported("Mark read"),
    unsubscribeFromMessage: () => icloudUnsupported("Unsubscribe"),
  })
