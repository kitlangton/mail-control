import { Schema } from "effect"

/**
 * A recoverable failure while talking to a mail provider (list, read, send,
 * mutate). Modeled as a schema-encodable tagged error per project convention.
 */
export class MailError extends Schema.TaggedErrorClass<MailError>("mail-control/MailError")("MailError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/**
 * A failure to load, decode, or resolve account configuration or credentials.
 */
export class MailConfigError extends Schema.TaggedErrorClass<MailConfigError>("mail-control/MailConfigError")(
  "MailConfigError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

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
