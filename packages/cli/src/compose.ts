import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"
import { Effect, FileSystem, Schema } from "effect"
import { lookup as lookupMime } from "mime-types"
import type { DownloadedAttachment } from "./service.js"
import { type Attachment, MailError, type MailMessageBody, type ReplyMailInput, type SendMailInput } from "./types.js"

export interface BodyInput {
  readonly body?: string
  readonly bodyFile?: string
  readonly required: boolean
  readonly action: string
}

export interface SendComposeInput extends BodyInput {
  readonly to: readonly string[]
  readonly subject: string
  readonly cc?: string
  readonly bcc?: string
  readonly attach: readonly string[]
}

export interface ReplyComposeInput extends BodyInput {
  readonly messageId: string
  readonly cc?: string
  readonly bcc?: string
  readonly attach: readonly string[]
}

export interface ForwardComposeInput extends BodyInput {
  readonly messageId: string
  readonly to: readonly string[]
  readonly cc?: string
  readonly bcc?: string
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")

const htmlLines = (value: string): string => escapeHtml(value).replace(/\n/g, "<br>")

const Contact = Schema.Struct({
  displayName: Schema.String,
  emails: Schema.Array(Schema.String),
})

const execFileAsync = promisify(execFile)

const CONTACTS_TIMEOUT_MS = 10_000

const resolveRecipient = Effect.fn("Mail.resolveRecipient")(function* (recipient: string) {
  if (recipient.includes("@")) return recipient

  const result = yield* Effect.tryPromise({
    try: async () => {
      const result = await execFileAsync("contacts", ["resolve", recipient, "--json"], {
        timeout: CONTACTS_TIMEOUT_MS,
      })
      return { stdout: result.stdout, stderr: result.stderr }
    },
    catch: (cause) =>
      new MailError({
        message: `Could not resolve contact '${recipient}': ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })

  const contact = yield* Effect.try({
    try: () => JSON.parse(result.stdout) as unknown,
    catch: (cause) => new MailError({ message: `Invalid contact data for '${recipient}'`, cause }),
  }).pipe(
    // contacts-control prints the control envelope ({ ok, items: [contact] }); older builds print the contact.
    Effect.map((value) =>
      value !== null && typeof value === "object" && "items" in value && Array.isArray(value.items)
        ? value.items[0]
        : value,
    ),
    Effect.flatMap(Schema.decodeUnknownEffect(Contact)),
    Effect.mapError((cause) => new MailError({ message: `Invalid contact data for '${recipient}'`, cause })),
  )

  const email = contact.emails[0]
  if (email === undefined) {
    return yield* new MailError({ message: `Contact '${contact.displayName}' has no email address.` })
  }
  return email
})

const requireRecipients = (to: readonly string[]): Effect.Effect<string, MailError> =>
  to.length === 0
    ? Effect.fail(new MailError({ message: "At least one recipient (-t) is required." }))
    : Effect.forEach(to, resolveRecipient).pipe(Effect.map((recipients) => recipients.join(", ")))

export const resolveBody = ({
  body,
  bodyFile,
  required,
  action,
}: BodyInput): Effect.Effect<string, MailError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (bodyFile !== undefined) {
      const fs = yield* FileSystem.FileSystem
      return yield* fs
        .readFileString(bodyFile)
        .pipe(
          Effect.mapError(
            (cause) => new MailError({ message: `Failed to read body file ${bodyFile}: ${String(cause)}`, cause }),
          ),
        )
    }

    if (body !== undefined) {
      return body
    }

    if (!required) {
      return ""
    }

    return yield* new MailError({ message: `Either --body or --body-file must be provided for ${action}.` })
  })

export const loadAttachments = (
  files: readonly string[],
): Effect.Effect<readonly Attachment[], MailError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* Effect.all(
      files.map((filePath) =>
        Effect.gen(function* () {
          const content = yield* fs
            .readFile(filePath)
            .pipe(
              Effect.mapError(
                (cause) => new MailError({ message: `Failed to read attachment ${filePath}: ${String(cause)}`, cause }),
              ),
            )
          const filename = path.basename(filePath)
          const mimeType = lookupMime(filename) || "application/octet-stream"
          return { filename, mimeType, content }
        }),
      ),
    )
  })

export const makeSendInput = (
  input: SendComposeInput,
): Effect.Effect<SendMailInput, MailError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const recipients = yield* requireRecipients(input.to)
    const body = yield* resolveBody(input)
    const attachments = yield* loadAttachments(input.attach)
    return {
      to: recipients,
      subject: input.subject,
      body,
      ...(input.cc !== undefined ? { cc: input.cc } : {}),
      ...(input.bcc !== undefined ? { bcc: input.bcc } : {}),
      ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
    }
  })

export const makeReplyInput = (
  input: ReplyComposeInput,
): Effect.Effect<ReplyMailInput, MailError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const body = yield* resolveBody(input)
    const attachments = yield* loadAttachments(input.attach)
    return {
      messageId: input.messageId,
      body,
      ...(input.cc !== undefined ? { cc: input.cc } : {}),
      ...(input.bcc !== undefined ? { bcc: input.bcc } : {}),
      ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
    }
  })

export const makeForwardInput = (
  input: ForwardComposeInput,
  original: MailMessageBody,
  downloaded: readonly DownloadedAttachment[],
): Effect.Effect<SendMailInput, MailError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const recipients = yield* requireRecipients(input.to)
    const intro = yield* resolveBody(input)
    const forwardedHeader = [
      "---------- Forwarded message ----------",
      `From: ${original.from}`,
      ...(original.date ? [`Date: ${original.date}`] : []),
      `Subject: ${original.subject}`,
      "",
    ].join("\n")
    const lowerSubject = original.subject.toLowerCase()
    const subject =
      lowerSubject.startsWith("fwd:") || lowerSubject.startsWith("fw:") ? original.subject : `Fwd: ${original.subject}`
    const htmlBody = original.htmlBody
      ? `${intro ? `<p>${htmlLines(intro)}</p>` : ""}<p>${htmlLines(forwardedHeader)}</p><blockquote>${original.htmlBody}</blockquote>`
      : undefined

    return {
      to: recipients,
      subject,
      body: `${intro ? `${intro}\n\n` : ""}${forwardedHeader}\n${original.body}`,
      ...(htmlBody !== undefined ? { htmlBody } : {}),
      ...(input.cc !== undefined ? { cc: input.cc } : {}),
      ...(input.bcc !== undefined ? { bcc: input.bcc } : {}),
      ...(downloaded.length > 0 ? { attachments: [...downloaded] } : {}),
    }
  })
