import type { Attachment, ReplyEmailInput, SendEmailInput } from "@mail-control/gmail"
import type { AccountId } from "./config.js"

// Typed errors live in errors.ts (Schema-backed); re-export for existing imports.
export { MailConfigError, MailError } from "./errors.js"
// Re-export shared types
export type { AccountId, Attachment, ReplyEmailInput, SendEmailInput }

/** Alias for SendEmailInput for backward compatibility */
export type SendMailInput = SendEmailInput

/** Alias for ReplyEmailInput for backward compatibility */
export type ReplyMailInput = ReplyEmailInput

export type MailStatus = "all" | "unread" | "read"

export interface MailMessageSummary {
  account: AccountId
  id: string
  subject: string
  from: string
  date?: string
  snippet?: string
  unread?: boolean
}

export interface ListMailOptions {
  maxResults?: number
  status?: MailStatus
  query?: string
  mailbox?: string
  inboxOnly?: boolean
}

export interface ReadMailInput {
  id: string
  mailbox?: string
}

export interface AttachmentMeta {
  id: string
  filename: string
  mimeType: string
  size: number
}

export interface MailMessageBody {
  id: string
  subject: string
  from: string
  date?: string
  body: string
  htmlBody?: string
  unread?: boolean
  attachments?: AttachmentMeta[]
}
