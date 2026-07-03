import { parseListUnsubscribe } from "@mail-control/gmail"
import { Effect, Redacted } from "effect"
import { ImapFlow } from "imapflow"
import nodemailer from "nodemailer"
import type { AccountId, ICloudAccountConfig } from "./config.js"
import { MailError, mailError } from "./errors.js"
import type {
  Attachment,
  ListMailOptions,
  MailMessageBody,
  MailMessageSummary,
  ReadMailInput,
  SendMailInput,
} from "./types.js"

export type ICloudUnsubscribeMethod = "one-click" | "mailto"

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
  subject?: string
  from?: { name?: string; address?: string }[]
  date?: Date
}

/** Shared envelope → display fields, used by both list and read. */
const envelopeFields = (envelope: Envelope | undefined, flags: Set<string> | undefined) => {
  const fromEntry = envelope?.from?.[0]
  return {
    subject: envelope?.subject ?? "(no subject)",
    from: formatAddress(fromEntry?.name, fromEntry?.address),
    ...(envelope?.date ? { date: envelope.date.toISOString() } : {}),
    ...(flags ? { unread: !flags.has("\\Seen") } : {}),
  }
}

const buildSearchCriteria = (options?: ListMailOptions): Record<string, unknown> => {
  const status = options?.status ?? "all"
  const query = options?.query

  if (query) {
    const criteria: Record<string, unknown> = {}
    if (status === "unread") criteria.seen = false
    if (status === "read") criteria.seen = true
    criteria.or = [{ subject: query }, { from: query }]
    return criteria
  }

  if (status === "unread") return { seen: false }
  if (status === "read") return { seen: true }
  return {}
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
    mailbox?: string,
  ): Effect.Effect<A, MailError> =>
    Effect.acquireUseRelease(
      Effect.tryPromise({
        try: async () => {
          const imap = new ImapFlow({
            host: config.imap.host,
            port: config.imap.port,
            secure: config.imap.secure,
            logger: false,
            auth: { user: config.email, pass: Redacted.value(config.password) },
          })
          await imap.connect()
          return imap
        },
        catch: mailError("Failed to connect to iCloud IMAP"),
      }),
      (client) => f(client, mailbox ?? config.imap.mailbox),
      (client) => Effect.promise(() => client.logout()).pipe(Effect.ignore),
    )

  const listMessages = (options?: ListMailOptions) =>
    withClient(
      (client, mailbox) =>
        Effect.tryPromise({
          try: async () => {
            await client.mailboxOpen(mailbox)
            const results = await client.search(buildSearchCriteria(options) as Parameters<ImapFlow["search"]>[0])
            const ids = Array.isArray(results) ? results : []
            const limit = options?.maxResults ?? 10
            const target = ids.slice(-limit).reverse()

            const summaries: MailMessageSummary[] = []
            for await (const rawMessage of client.fetch(target, { envelope: true, flags: true })) {
              const message = rawMessage as { uid: number; envelope?: Envelope; flags?: Set<string> }
              summaries.push({
                account: accountId,
                id: String(message.uid),
                ...envelopeFields(message.envelope, message.flags),
              })
            }
            return summaries
          },
          catch: mailError("Failed to list iCloud messages"),
        }),
      options?.mailbox,
    )

  const readMessage = (input: ReadMailInput) =>
    withClient(
      (client, mailbox) =>
        Effect.tryPromise({
          try: async () => {
            await client.mailboxOpen(mailbox)
            const uid = Number(input.id)
            const iterator = client.fetch([uid], { envelope: true, flags: true, bodyParts: ["TEXT"] })
            const result = await iterator.next()
            if (result.done || !result.value) return undefined

            const rawMessage = result.value as {
              uid: number
              envelope?: Envelope
              flags?: Set<string>
              bodyParts?: Map<string, Buffer>
            }
            const bodyBuffer = rawMessage.bodyParts?.get("TEXT") ?? rawMessage.bodyParts?.values().next().value
            return {
              id: String(rawMessage.uid),
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
      input.mailbox,
    )

  const sendEmail = (input: SendMailInput) =>
    Effect.tryPromise({
      try: async () => {
        const transporter = nodemailer.createTransport({
          host: config.smtp.host,
          port: config.smtp.port,
          secure: config.smtp.secure,
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
    withClient((client, mailbox) =>
      Effect.tryPromise({
        try: async () => {
          await client.mailboxOpen(mailbox)
          const mailboxes = await client.list()
          const destination = mailboxes.find((candidate) => candidate.specialUse === specialUse)
          await client.messageMove({ uid: Number(messageId) }, destination?.path ?? fallback, { uid: true })
        },
        catch: mailError(`Failed to ${verb} iCloud message ${messageId}`),
      }),
    )

  const archiveMessage = (messageId: string) => moveToSpecialUse(messageId, "\\Archive", "Archive", "archive")
  const trashMessage = (messageId: string) => moveToSpecialUse(messageId, "\\Trash", "Trash", "move to trash")

  const unsubscribeFromMessage = (messageId: string): Effect.Effect<ICloudUnsubscribeResult, MailError> =>
    withClient((client, mailbox) =>
      Effect.gen(function* () {
        const rawHeaders = yield* Effect.tryPromise({
          try: async () => {
            await client.mailboxOpen(mailbox)
            const uid = Number(messageId)
            const iterator = client.fetch([uid], { headers: ["List-Unsubscribe", "List-Unsubscribe-Post"] })
            const result = await iterator.next()
            if (result.done || !result.value) return undefined
            const message = result.value as { headers?: Buffer }
            return message.headers?.toString("utf8")
          },
          catch: mailError(`Failed to retrieve unsubscribe headers for iCloud message ${messageId}`),
        })

        if (rawHeaders === undefined) {
          return yield* Effect.fail(new MailError({ message: `No iCloud message found with id ${messageId}` }))
        }

        const headers = parseRawHeaders(rawHeaders)
        const listUnsubscribe = headers.get("list-unsubscribe")

        if (!listUnsubscribe) {
          return yield* Effect.fail(
            new MailError({ message: `Message ${messageId} does not provide a List-Unsubscribe header` }),
          )
        }

        const destinations = parseListUnsubscribe(listUnsubscribe)
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
              })
              if (!response.ok) {
                throw new Error(`HTTP ${response.status} ${response.statusText}`)
              }
            },
            catch: (cause) =>
              new MailError({ message: `One-click unsubscribe failed for message ${messageId}`, cause }),
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

        return yield* Effect.fail(
          new MailError({
            message: `Message ${messageId} only provides an interactive web unsubscribe; no one-click or mailto option is available`,
          }),
        )
      }),
    )

  return { listMessages, readMessage, sendEmail, archiveMessage, trashMessage, unsubscribeFromMessage }
}
