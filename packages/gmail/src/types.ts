import { Data } from "effect"

const TaggedError = <Tag extends string>(tag: Tag) =>
  Data.TaggedError(tag)<{
    readonly message: string
    readonly cause?: unknown
  }>

/**
 * Input required to send an email via Gmail.
 */
export interface Attachment {
  /** Filename to display */
  filename: string
  /** MIME type (e.g., "application/pdf") */
  mimeType: string
  /** File content as Buffer or Uint8Array */
  content: Buffer | Uint8Array
}

export interface SendEmailInput {
  /** Recipient email address */
  to: string
  /** Subject line */
  subject: string
  /** Plain text body */
  body: string
  /** Optional HTML body */
  htmlBody?: string
  /** Optional CC recipients (comma-separated) */
  cc?: string
  /** Optional BCC recipients (comma-separated) */
  bcc?: string
  /** Optional file attachments */
  attachments?: Attachment[]
}

/**
 * Options available when listing messages.
 */
export interface ListMessagesOptions {
  /** Max number of messages to fetch (default 10) */
  maxResults?: number
  /** Optional Gmail search query */
  query?: string
  /** Optional label filters */
  labelIds?: readonly string[]
}

/**
 * Light-weight representation of a Gmail message.
 */
export interface GmailMessageSummary {
  /** Gmail message ID */
  id: string
  /** Gmail thread ID */
  threadId?: string
  /** Subject header if present */
  subject: string
  /** From header if present */
  from: string
  /** Date header (raw string) */
  date?: string
  /** Message snippet provided by Gmail */
  snippet?: string
  /** True when the message is unread */
  unread?: boolean
}

/**
 * Input for creating a draft (same structure as sending, but creates draft instead).
 */
export type CreateDraftInput = SendEmailInput

/**
 * Input for replying to an existing email thread.
 */
export interface ReplyEmailInput {
  /** Message ID to reply to */
  messageId: string
  /** Plain text body of the reply */
  body: string
  /** Optional HTML body of the reply */
  htmlBody?: string
  /** Optional CC recipients (comma-separated) */
  cc?: string
  /** Optional BCC recipients (comma-separated) */
  bcc?: string
  /** Optional file attachments */
  attachments?: Attachment[]
}

/**
 * Information about a created draft.
 */
export interface GmailDraftInfo {
  /** Draft ID */
  id: string
  /** Message ID within the draft */
  messageId: string
}

/**
 * Metadata about a Gmail attachment (does not include content).
 */
export interface GmailAttachmentMeta {
  /** Gmail attachment ID (used to fetch content) */
  id: string
  /** Original filename */
  filename: string
  /** MIME type */
  mimeType: string
  /** Size in bytes */
  size: number
}

/**
 * Full message body representation.
 */
export interface GmailMessageBody {
  /** Gmail message ID */
  id: string
  /** Subject header if present */
  subject: string
  /** From header if present */
  from: string
  /** Date header (raw string) */
  date?: string
  /** Plain text body */
  body: string
  /** HTML body when the source message includes one */
  htmlBody?: string
  /** True when the message is unread */
  unread?: boolean
  /** Attachment metadata (empty array when no attachments) */
  attachments: GmailAttachmentMeta[]
}

export type GmailUnsubscribeMethod = "one-click" | "mailto"

export interface GmailUnsubscribeResult {
  method: GmailUnsubscribeMethod
  destination: string
}

/**
 * Error thrown when configuration values are missing or invalid.
 */
export class GmailConfigError extends TaggedError("GmailConfigError") {}

/**
 * Error thrown when a Gmail API request fails.
 */
export class GmailError extends TaggedError("GmailError") {}

/**
 * Error thrown when OAuth2 authorization fails or is cancelled.
 */
export class GmailAuthError extends TaggedError("GmailAuthError") {}
