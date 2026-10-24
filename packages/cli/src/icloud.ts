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

const QUERY_TOKEN_PATTERN = /([a-z_]+):(?:"([^"]+)"|(\S+))|"([^"]+)"|(\S+)/gi

export const buildSearchCriteria = (options?: ListMailOptions, now = new Date()): Record<string, unknown> => {
  const status = options?.status ?? "all"
  const criteria: Record<string, unknown> = {}

  if (status === "unread") criteria.seen = false
  if (status === "read") criteria.seen = true
  if (options?.since) criteria.since = options.since

  const rawQuery = options?.query?.trim()
  if (!rawQuery) return criteria

  const freeTerms: string[] = []
  for (const match of rawQuery.matchAll(QUERY_TOKEN_PATTERN)) {
    const key = match[1]?.toLowerCase()
    const val = match[2] ?? match[3] ?? ""
    const phrase = match[4] ?? match[5] ?? ""

    if (key && val) {
      if (key === "from") {
        criteria.from = val
        continue
      }
      if (key === "to") {
        criteria.to = val
        continue
      }
      if (key === "subject") {
        criteria.subject = val
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
      }
      if (key === "newer_than") {
        const parsed = parseDurationText(val, now)
        if (parsed) {
          criteria.since = parsed.sinceDate
          continue
        }
      }
      if (key === "older_than") {
        const parsed = parseDurationText(val, now)
        if (parsed) {
          criteria.before = parsed.sinceDate
          continue
        }
      }
      freeTerms.push(match[0])
    } else if (phrase) {
      freeTerms.push(phrase)
    }
  }

  if (freeTerms.length > 0) {
    const text = freeTerms.join(" ")
    criteria.or = [{ subject: text }, { from: text }]
  }

  return criteria
}

const parseUid = (id: string): Effect.Effect<number, MailError> => {
  const uid = Number(id)
  return Number.isSafeInteger(uid) && uid > 0
    ? Effect.succeed(uid)
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
    withClient(
      (client, mailbox) =>
        Effect.tryPromise({
          try: async () => {
            const box = await client.mailboxOpen(mailbox, { readOnly: true })
            const limit = options?.maxResults ?? 10
            if (box.exists === 0 || limit <= 0) return []

            const results = await client.search(buildSearchCriteria(options) as Parameters<ImapFlow["search"]>[0], {
              uid: true,
            })
            const ids = Array.isArray(results) ? results : []
            if (ids.length === 0) return []
            const target = [...ids].sort((a, b) => a - b).slice(-limit)

            const summaries: MailMessageSummary[] = []
            for await (const rawMessage of client.fetch(target, { envelope: true, flags: true }, { uid: true })) {
              const message = rawMessage as { uid: number; envelope?: Envelope; flags?: Set<string> }
              summaries.push({
                account: accountId,
                id: String(message.uid),
                snippet: "",
                ...envelopeFields(message.envelope, message.flags),
              })
            }
            return summaries.reverse()
          },
          catch: mailError("Failed to list iCloud messages"),
        }),
      { ...(options?.mailbox !== undefined ? { mailbox: options.mailbox } : {}), readOnly: true },
    )

  const readMessage = (input: ReadMailInput) =>
    Effect.gen(function* () {
      const uid = yield* parseUid(input.id)
      return yield* withClient(
        (client, mailbox) =>
          Effect.tryPromise({
            try: async () => {
              await client.mailboxOpen(mailbox, { readOnly: true })
              const rawMessage = await client.fetchOne(
                uid,
                { envelope: true, flags: true, bodyParts: ["TEXT"] },
                { uid: true },
              )
              if (!rawMessage) return undefined
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
        { ...(input.mailbox !== undefined ? { mailbox: input.mailbox } : {}), readOnly: true },
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
          socketTimeout: IMAP_SOCKET_TIMEOUT_MS,
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
      const uid = yield* parseUid(messageId)
      yield* withClient((client, mailbox) =>
        Effect.tryPromise({
          try: async () => {
            await client.mailboxOpen(mailbox)
            const mailboxes = await client.list()
            const destination = mailboxes.find((candidate) => candidate.specialUse === specialUse)
            await client.messageMove({ uid }, destination?.path ?? fallback, { uid: true })
          },
          catch: mailError(`Failed to ${verb} iCloud message ${messageId}`),
        }),
      )
    })

  const archiveMessage = (messageId: string) => moveToSpecialUse(messageId, "\\Archive", "Archive", "archive")
  const trashMessage = (messageId: string) =>
    moveToSpecialUse(messageId, "\\Trash", "Deleted Messages", "move to trash")

  const markMessageRead = (messageId: string) =>
    Effect.gen(function* () {
      const uid = yield* parseUid(messageId)
      yield* withClient((client, mailbox) =>
        Effect.tryPromise({
          try: async () => {
            await client.mailboxOpen(mailbox)
            await client.messageFlagsAdd({ uid }, ["\\Seen"], { uid: true })
          },
          catch: mailError(`Failed to mark iCloud message ${messageId} read`),
        }),
      )
    })

  const unsubscribeFromMessage = (messageId: string): Effect.Effect<ICloudUnsubscribeResult, MailError> =>
    Effect.gen(function* () {
      const uid = yield* parseUid(messageId)
      const message = yield* withClient(
        (client, mailbox) =>
          Effect.tryPromise({
            try: async () => {
              await client.mailboxOpen(mailbox, { readOnly: true })
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
        { readOnly: true },
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
