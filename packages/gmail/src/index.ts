/**
 * @packageDocumentation
 * Gmail API client built on Effect.
 *
 * @example
 * ```typescript
 * import { ConfigProvider, Effect } from "effect"
 * import { GmailConfig, GmailService } from "@mail-control/gmail"
 *
 * const program = Effect.gen(function* () {
 *   const gmail = yield* GmailService
 *   const messageId = yield* gmail.sendEmail({
 *     to: "recipient@example.com",
 *     subject: "Hello from Effect",
 *     body: "Sent using the GmailService",
 *   })
 *   return messageId
 * }).pipe(
 *   Effect.provide(GmailService.layer),
 *   Effect.provide(GmailConfig.layer),
 *   Effect.withConfigProvider(
 *     ConfigProvider.fromMap(
 *       new Map([
 *         ["GOOGLE_CLIENT_SECRET_PATH", "/path/to/credentials.json"],
 *         ["GOOGLE_TOKEN_PATH", "/path/to/token.json"],
 *       ]),
 *     ),
 *   ),
 * )
 *
 * await Effect.runPromise(program)
 * ```
 */

export { type AuthorizeGmailOptions, authorizeGmail, GMAIL_SCOPES } from "./auth.js"
export { defaultGmailCredentialsPath, defaultGmailTokenPath } from "./paths.js"
export {
  GmailConfig,
  type GmailInstanceConfig,
  GmailService,
  type GmailServiceInterface,
  makeGmailService,
  parseListUnsubscribe,
} from "./service.js"
export {
  type Attachment,
  type CreateDraftInput,
  type GmailAttachmentMeta,
  GmailAuthError,
  GmailConfigError,
  type GmailDraftInfo,
  GmailError,
  type GmailMessageBody,
  type GmailMessageSummary,
  type GmailUnsubscribeMethod,
  type GmailUnsubscribeResult,
  type ListMessagesOptions,
  type ReplyEmailInput,
  type SendEmailInput,
} from "./types.js"
