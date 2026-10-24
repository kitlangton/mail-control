import { Schema } from "effect"

/**
 * A recoverable failure while talking to a mail provider (list, read, send,
 * mutate). Modeled as a schema-encodable tagged error per project convention.
 */
export class MailError extends Schema.TaggedError<MailError>()("MailError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/**
 * A failure to load, decode, or resolve account configuration or credentials.
 */
export class MailConfigError extends Schema.TaggedError<MailConfigError>()("MailConfigError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** `Effect.mapError(mailError("..."))` — wrap a cause as a `MailError`. */
export const mailError =
  (message: string) =>
  (cause: unknown): MailError =>
    new MailError({ message, cause })

/** `Effect.mapError(mailConfigError("..."))` — wrap a cause as a `MailConfigError`. */
export const mailConfigError =
  (message: string) =>
  (cause: unknown): MailConfigError =>
    new MailConfigError({ message, cause })

/** Narrow a config failure into a `MailError`, preserving the cause chain. */
export const toMailError = (cause: MailError | MailConfigError): MailError =>
  cause instanceof MailError ? cause : new MailError({ message: cause.message, cause })

/** Preserve an actionable sign-in hint without printing provider responses or tokens. */
export const accountFailure = (account: string, error: MailError): MailError => {
  let cause: unknown = error
  for (let depth = 0; depth < 8 && typeof cause === "object" && cause !== null; depth++) {
    const detail = cause as {
      _tag?: string
      code?: unknown
      authenticationFailed?: unknown
      serverResponseCode?: unknown
      message?: unknown
      response?: { status?: number; data?: { error?: unknown } }
      cause?: unknown
    }
    if (
      detail._tag === "GmailAuthError" ||
      detail._tag === "GmailConfigError" ||
      detail.authenticationFailed === true ||
      detail.serverResponseCode === "AUTHENTICATIONFAILED" ||
      detail.code === 401 ||
      detail.code === "invalid_grant" ||
      detail.response?.status === 401 ||
      detail.response?.data?.error === "invalid_grant" ||
      (typeof detail.message === "string" && detail.message.includes("invalid_grant"))
    ) {
      return new MailError({ message: `Sign in again: run mail auth ${account}`, cause: error })
    }
    cause = detail.cause
  }
  return error
}

const HOST_ERROR_PATTERN =
  /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ETIMEOUT|CONNECT_TIMEOUT|GREETING_TIMEOUT|TimeoutError|network|timed out/i

/** True when `error` or any nested `cause` indicates a network/host/timeout failure. */
export const isHostFailure = (error: unknown): boolean => {
  let cause: unknown = error
  for (let depth = 0; depth < 8 && typeof cause === "object" && cause !== null; depth++) {
    const detail = cause as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown }
    if (
      (typeof detail.code === "string" && HOST_ERROR_PATTERN.test(detail.code)) ||
      (typeof detail.name === "string" && HOST_ERROR_PATTERN.test(detail.name)) ||
      (typeof detail.message === "string" && HOST_ERROR_PATTERN.test(detail.message))
    ) {
      return true
    }
    cause = detail.cause
  }
  return false
}
