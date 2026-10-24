import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Config, Context, Effect, Layer, Option, Redacted } from "effect"
import type { gmail_v1 } from "googleapis/build/src/apis/gmail/index.js"
import * as google from "googleapis/build/src/apis/gmail/index.js"
import { GMAIL_SCOPES, GMAIL_SETTINGS_SCOPE, readClientInfo } from "./auth.js"
import { defaultGmailCredentialsPath, defaultGmailTokenPath } from "./paths.js"
import type {
  CreateDraftInput,
  GmailAttachmentMeta,
  GmailDraftInfo,
  GmailFilter,
  GmailFilterInput,
  GmailLabel,
  GmailMessageBody,
  GmailMessageSummary,
  GmailUnsubscribeResult,
  ListMessagesOptions,
  ReplyEmailInput,
  SendEmailInput,
} from "./types.js"
import { GmailAuthError, GmailConfigError, GmailError, GmailScopeError } from "./types.js"

const DEFAULT_SCOPES = [...GMAIL_SCOPES]
const GMAIL_READ_TIMEOUT_MS = 30_000
const UNSUBSCRIBE_TIMEOUT_MS = 15_000
const GMAIL_BATCH_CHUNK_SIZE = 50
const GMAIL_FALLBACK_CONCURRENCY = 8
type GmailOAuth2Client = InstanceType<typeof google.auth.OAuth2>
type OAuth2Credentials = GmailOAuth2Client["credentials"]

/**
 * Configuration for creating a Gmail service instance with explicit paths.
 * Use this with `makeGmailService` for multi-account support.
 */
export interface GmailInstanceConfig {
  /** Path to the Google OAuth credentials JSON file */
  credentialsPath: string
  /** Path to store/read the OAuth token */
  tokenPath: string
  /** OAuth scopes (defaults to send, readonly, compose) */
  scopes?: string[]
}

export class GmailConfig extends Context.Service<GmailConfig>()("@mail-control/gmail/GmailConfig", {
  make: Effect.gen(function* () {
    const credentialsPath = yield* Config.String("GOOGLE_CLIENT_SECRET_PATH").pipe(
      Config.orElse(() => Config.succeed(defaultGmailCredentialsPath())),
    )
    const tokenPathOption = yield* Config.option(Config.String("GOOGLE_TOKEN_PATH"))
    const scopesOption = yield* Config.option(Config.Redacted("GOOGLE_SCOPES"))

    const resolvedTokenPath = Option.match(tokenPathOption, {
      onNone: () => defaultGmailTokenPath(credentialsPath),
      onSome: (value) => value,
    })

    const scopes = Option.match(scopesOption, {
      onNone: () => DEFAULT_SCOPES,
      onSome: (value) =>
        Redacted.value(value)
          .split(/[,\s]+/)
          .map((scope) => scope.trim())
          .filter(Boolean),
    })

    if (scopes.length === 0) {
      return yield* Effect.fail(
        new GmailConfigError({
          message: "GOOGLE_SCOPES must include at least one scope",
        }),
      )
    }

    return {
      credentialsPath,
      tokenPath: resolvedTokenPath,
      scopes,
    } as const
  }),
}) {
  static readonly layer = Layer.effect(this)(this.make)
}

const isFileNotFound = (cause: unknown): cause is NodeJS.ErrnoException =>
  typeof cause === "object" && cause !== null && "code" in cause && (cause as NodeJS.ErrnoException).code === "ENOENT"

const findHeader = (
  headers: readonly gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string | undefined => {
  const target = name.toLowerCase()
  return headers?.find((header) => header.name?.toLowerCase() === target)?.value ?? undefined
}

const encodeBase64Url = (value: string): string => Buffer.from(value, "utf8").toString("base64url")
const decodeBase64UrlBuffer = (value: string): Buffer => Buffer.from(value, "base64url")
const decodeBase64Url = (value: string): string => decodeBase64UrlBuffer(value).toString("utf8")

const readTokenIfExists = (tokenPath: string): Effect.Effect<Option.Option<OAuth2Credentials>, GmailError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        await fs.access(tokenPath, fsConstants.F_OK)
      } catch (cause) {
        if (isFileNotFound(cause)) {
          return Option.none<OAuth2Credentials>()
        }
        throw new GmailError({
          message: `Failed to access token file at ${tokenPath}`,
          cause,
        })
      }

      let raw: string
      try {
        raw = await fs.readFile(tokenPath, "utf8")
      } catch (cause) {
        throw new GmailError({
          message: `Failed to read token file at ${tokenPath}`,
          cause,
        })
      }

      try {
        const parsed = JSON.parse(raw) as OAuth2Credentials
        return Option.some(parsed)
      } catch (cause) {
        throw new GmailError({
          message: `Failed to parse token JSON at ${tokenPath}`,
          cause,
        })
      }
    },
    catch: (cause) =>
      cause instanceof GmailError
        ? cause
        : new GmailError({
            message: `Unexpected error while reading token file at ${tokenPath}`,
            cause,
          }),
  })

const saveToken = (tokenPath: string, credentials: OAuth2Credentials): Effect.Effect<void, GmailError> =>
  Effect.tryPromise({
    try: async () => {
      const directory = path.dirname(tokenPath)

      try {
        await fs.mkdir(directory, { recursive: true })
      } catch (cause) {
        throw new GmailError({
          message: `Failed to create token directory at ${directory}`,
          cause,
        })
      }

      const payload = `${JSON.stringify(credentials, null, 2)}\n`

      try {
        await fs.writeFile(tokenPath, payload, { encoding: "utf8", mode: 0o600 })
        await fs.chmod(tokenPath, 0o600)
      } catch (cause) {
        throw new GmailError({
          message: `Failed to write token file at ${tokenPath}`,
          cause,
        })
      }
    },
    catch: (cause) =>
      cause instanceof GmailError
        ? cause
        : new GmailError({
            message: `Unexpected error saving token to ${tokenPath}`,
            cause,
          }),
  })

/**
 * The interface returned by `makeGmailService`.
 * Use this type when storing Gmail service instances.
 */
export interface GmailServiceInterface {
  authorize: () => Effect.Effect<GmailOAuth2Client, GmailConfigError | GmailError | GmailAuthError>
  sendEmail: (input: SendEmailInput) => Effect.Effect<string, GmailError | GmailConfigError | GmailAuthError>
  replyToEmail: (input: ReplyEmailInput) => Effect.Effect<string, GmailError | GmailConfigError | GmailAuthError>
  createDraft: (
    input: CreateDraftInput,
  ) => Effect.Effect<GmailDraftInfo, GmailError | GmailConfigError | GmailAuthError>
  readMessage: (id: string) => Effect.Effect<GmailMessageBody, GmailError | GmailConfigError | GmailAuthError>
  listMessages: (
    options?: ListMessagesOptions,
  ) => Effect.Effect<GmailMessageSummary[], GmailError | GmailConfigError | GmailAuthError>
  getAttachment: (
    messageId: string,
    attachmentId: string,
  ) => Effect.Effect<Buffer, GmailError | GmailConfigError | GmailAuthError>
  archiveMessage: (id: string) => Effect.Effect<void, GmailError | GmailConfigError | GmailAuthError>
  trashMessage: (id: string) => Effect.Effect<void, GmailError | GmailConfigError | GmailAuthError>
  markMessageRead: (id: string) => Effect.Effect<void, GmailError | GmailConfigError | GmailAuthError>
  unsubscribeFromMessage: (
    id: string,
  ) => Effect.Effect<GmailUnsubscribeResult, GmailError | GmailConfigError | GmailAuthError>
  listLabels: () => Effect.Effect<GmailLabel[], GmailError | GmailConfigError | GmailAuthError>
  createLabel: (name: string) => Effect.Effect<GmailLabel, GmailError | GmailConfigError | GmailAuthError>
  listFilters: () => Effect.Effect<GmailFilter[], GmailError | GmailConfigError | GmailAuthError | GmailScopeError>
  createFilter: (
    input: GmailFilterInput,
  ) => Effect.Effect<GmailFilter, GmailError | GmailConfigError | GmailAuthError | GmailScopeError>
  deleteFilter: (id: string) => Effect.Effect<void, GmailError | GmailConfigError | GmailAuthError | GmailScopeError>
}

/**
 * True when a Gmail API failure means the OAuth token lacks a required scope
 * (HTTP 403 `insufficientPermissions` / `ACCESS_TOKEN_SCOPE_INSUFFICIENT`).
 */
export const isInsufficientScopeError = (cause: unknown): boolean => {
  if (typeof cause !== "object" || cause === null) return false
  const error = cause as {
    readonly status?: unknown
    readonly code?: unknown
    readonly message?: unknown
    readonly errors?: unknown
    readonly response?: { readonly status?: unknown; readonly data?: unknown }
  }
  const status = Number(error.status ?? error.response?.status ?? error.code)
  if (status !== 403) return false
  let details: string
  try {
    details = JSON.stringify([error.message, error.errors, error.response?.data])
  } catch {
    details = String(error.message)
  }
  return /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(details)
}

/** True when a token's granted `scope` string is known and lacks `scope`. */
export const lacksGrantedScope = (granted: string | null | undefined, scope: string): boolean =>
  typeof granted === "string" && !granted.split(/\s+/).includes(scope)

const present = <A>(value: A | null | undefined): value is A => value !== null && value !== undefined

const toGmailFilter = (filter: gmail_v1.Schema$Filter): GmailFilter => {
  const criteria = filter.criteria ?? {}
  const action = filter.action ?? {}
  return {
    id: filter.id ?? "",
    criteria: {
      ...(present(criteria.from) ? { from: criteria.from } : {}),
      ...(present(criteria.to) ? { to: criteria.to } : {}),
      ...(present(criteria.subject) ? { subject: criteria.subject } : {}),
      ...(present(criteria.query) ? { query: criteria.query } : {}),
      ...(present(criteria.negatedQuery) ? { negatedQuery: criteria.negatedQuery } : {}),
    },
    action: {
      ...(present(action.addLabelIds) ? { addLabelIds: action.addLabelIds } : {}),
      ...(present(action.removeLabelIds) ? { removeLabelIds: action.removeLabelIds } : {}),
    },
  }
}

export const parseListUnsubscribe = (value: string): readonly URL[] => {
  const entries = [...value.matchAll(/<([^>]+)>/g)].map((match) => match[1] ?? "")
  const candidates = entries.length > 0 ? entries : value.split(",").map((entry) => entry.trim())

  return candidates.flatMap((candidate) => {
    try {
      return [new URL(candidate)]
    } catch {
      return []
    }
  })
}

export const parseBatchMessagesResponse = (
  raw: string,
  contentType: string | null,
): ReadonlyMap<number, gmail_v1.Schema$Message> => {
  const boundaryMatch = contentType?.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]
  if (!boundary) return new Map()

  const results = new Map<number, gmail_v1.Schema$Message>()
  const parts = raw.split(`--${boundary}`)

  for (const part of parts) {
    const idMatch = part.match(/Content-ID:\s*<response-item(\d+)>/i)
    if (!idMatch?.[1]) continue
    const index = Number(idMatch[1])
    if (!Number.isSafeInteger(index)) continue

    const firstSep = part.search(/\r?\n\r?\n/)
    if (firstSep === -1) continue
    const firstSepLen = part.startsWith("\r\n\r\n", firstSep) ? 4 : 2
    const httpSection = part.slice(firstSep + firstSepLen)
    const statusMatch = httpSection.match(/^HTTP\/\d+(?:\.\d+)?\s+(\d{3})/i)
    if (statusMatch?.[1] !== "200") continue

    const secondSep = httpSection.search(/\r?\n\r?\n/)
    if (secondSep === -1) continue
    const secondSepLen = httpSection.startsWith("\r\n\r\n", secondSep) ? 4 : 2
    const jsonText = httpSection.slice(secondSep + secondSepLen).trim()
    if (!jsonText) continue

    try {
      results.set(index, JSON.parse(jsonText) as gmail_v1.Schema$Message)
    } catch {
      // Ignore malformed part; caller falls back to individual fetch if needed.
    }
  }

  return results
}

/**
 * Create a Gmail service instance with explicit configuration.
 * Use this for multi-account support instead of the singleton `GmailService`.
 *
 * @example
 * ```typescript
 * const gmail = yield* makeGmailService({
 *   credentialsPath: "/path/to/credentials.json",
 *   tokenPath: "/path/to/token.json",
 * })
 * const messages = yield* gmail.listMessages()
 * ```
 */
export const makeGmailService = (
  instanceConfig: GmailInstanceConfig,
): Effect.Effect<GmailServiceInterface, GmailConfigError | GmailError | GmailAuthError> =>
  Effect.gen(function* () {
    const config = {
      credentialsPath: instanceConfig.credentialsPath,
      tokenPath: instanceConfig.tokenPath,
      scopes: instanceConfig.scopes ?? DEFAULT_SCOPES,
    }
    let cachedClient: GmailOAuth2Client | undefined
    let cachedReadGmail: gmail_v1.Gmail | undefined
    let cachedWriteGmail: gmail_v1.Gmail | undefined
    let pendingTokenSave: Promise<void> = Promise.resolve()

    const flushTokenSave = Effect.promise(() => pendingTokenSave)

    const buildClient = (): Effect.Effect<GmailOAuth2Client, GmailConfigError | GmailError | GmailAuthError> =>
      Effect.gen(function* () {
        const { clientId, clientSecret, redirectUri } = yield* readClientInfo(config.credentialsPath)
        const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri)

        const existingToken = yield* readTokenIfExists(config.tokenPath)
        if (Option.isNone(existingToken)) {
          return yield* Effect.fail(
            new GmailAuthError({
              message: `Missing OAuth token at ${config.tokenPath}; run: mail auth`,
            }),
          )
        }

        let currentToken: OAuth2Credentials = existingToken.value
        client.setCredentials(currentToken)

        client.on("tokens", (tokens) => {
          const refreshToken = tokens.refresh_token ?? currentToken.refresh_token ?? null
          currentToken = {
            ...currentToken,
            ...tokens,
            refresh_token: refreshToken,
          }
          pendingTokenSave = pendingTokenSave.then(() =>
            Effect.runPromise(saveToken(config.tokenPath, currentToken).pipe(Effect.ignore)),
          )
        })

        return client
      })

    const ensureAuthorized = (): Effect.Effect<GmailOAuth2Client, GmailConfigError | GmailError | GmailAuthError> =>
      Effect.gen(function* () {
        if (cachedClient) {
          return cachedClient
        }

        const client = yield* buildClient()
        cachedClient = client
        return client
      })

    const getReadGmail = (): Effect.Effect<gmail_v1.Gmail, GmailConfigError | GmailError | GmailAuthError> =>
      Effect.gen(function* () {
        const client = yield* ensureAuthorized()
        if (!cachedReadGmail) {
          cachedReadGmail = google.gmail({ version: "v1", auth: client, timeout: GMAIL_READ_TIMEOUT_MS })
        }
        return cachedReadGmail
      })

    const getWriteGmail = (): Effect.Effect<gmail_v1.Gmail, GmailConfigError | GmailError | GmailAuthError> =>
      Effect.gen(function* () {
        const client = yield* ensureAuthorized()
        if (!cachedWriteGmail) {
          cachedWriteGmail = google.gmail({ version: "v1", auth: client })
        }
        return cachedWriteGmail
      })

    const gmailReadCall = <A>(message: string, request: (gmail: gmail_v1.Gmail) => Promise<A>) =>
      Effect.gen(function* () {
        const gmail = yield* getReadGmail()
        return yield* Effect.tryPromise({
          try: () => request(gmail),
          catch: (cause) => new GmailError({ message, cause }),
        }).pipe(Effect.ensuring(flushTokenSave))
      })

    const gmailWriteCall = <A>(message: string, request: (gmail: gmail_v1.Gmail) => Promise<A>) =>
      Effect.gen(function* () {
        const gmail = yield* getWriteGmail()
        return yield* Effect.tryPromise({
          try: () => request(gmail),
          catch: (cause) => new GmailError({ message, cause }),
        }).pipe(Effect.ensuring(flushTokenSave))
      })

    const stripCrLf = (value: string): string => value.replace(/[\r\n]+/g, " ").trim()

    const encodeHeaderValue = (value: string): string => {
      const clean = stripCrLf(value)
      if ([...clean].every((character) => character.charCodeAt(0) <= 0x7f)) return clean
      const encoded = Buffer.from(clean, "utf-8").toString("base64")
      return `=?UTF-8?B?${encoded}?=`
    }

    const buildMimeMessage = (
      input: SendEmailInput & { readonly inReplyTo?: string; readonly references?: string },
    ): string => {
      const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`
      const hasAttachments = Array.isArray(input.attachments) && input.attachments.length > 0
      const hasHtml = input.htmlBody !== undefined

      const headers = [
        `To: ${stripCrLf(input.to)}`,
        ...(input.cc ? [`Cc: ${stripCrLf(input.cc)}`] : []),
        ...(input.bcc ? [`Bcc: ${stripCrLf(input.bcc)}`] : []),
        `Subject: ${encodeHeaderValue(input.subject)}`,
        ...(input.inReplyTo ? [`In-Reply-To: ${stripCrLf(input.inReplyTo)}`] : []),
        ...(input.references ? [`References: ${stripCrLf(input.references)}`] : []),
        "MIME-Version: 1.0",
        hasAttachments
          ? `Content-Type: multipart/mixed; boundary="${boundary}"`
          : hasHtml
            ? "Content-Type: text/html; charset=utf-8"
            : "Content-Type: text/plain; charset=utf-8",
        "",
      ]

      if (!hasAttachments) {
        return [...headers, input.htmlBody ?? input.body].join("\r\n")
      }

      const parts: string[] = [
        ...headers,
        "",
        `--${boundary}`,
        hasHtml ? "Content-Type: text/html; charset=utf-8" : "Content-Type: text/plain; charset=utf-8",
        "",
        input.htmlBody ?? input.body,
      ]

      for (const attachment of input.attachments ?? []) {
        const base64Content = Buffer.from(attachment.content).toString("base64")
        parts.push(
          `--${boundary}`,
          `Content-Type: ${attachment.mimeType}; name="${attachment.filename}"`,
          "Content-Transfer-Encoding: base64",
          `Content-Disposition: attachment; filename="${attachment.filename}"`,
          "",
          base64Content,
        )
      }

      parts.push(`--${boundary}--`)
      return parts.join("\r\n")
    }

    const sendEmail = (input: SendEmailInput): Effect.Effect<string, GmailError | GmailConfigError | GmailAuthError> =>
      Effect.gen(function* () {
        const encodedMessage = encodeBase64Url(buildMimeMessage(input))
        const response = yield* gmailWriteCall("Failed to send email via Gmail API", (gmail) =>
          gmail.users.messages.send({
            userId: "me",
            requestBody: { raw: encodedMessage },
          }),
        )
        return response.data.id ?? ""
      })

    const replyToEmail = (
      input: ReplyEmailInput,
    ): Effect.Effect<string, GmailError | GmailConfigError | GmailAuthError> =>
      Effect.gen(function* () {
        const originalMessage = yield* gmailReadCall(
          `Failed to retrieve original message ${input.messageId}`,
          (gmail) =>
            gmail.users.messages.get({
              userId: "me",
              id: input.messageId,
              format: "metadata",
              metadataHeaders: ["Subject", "From", "To", "Message-ID", "References"],
            }),
        )

        const headers = originalMessage.data.payload?.headers
        const originalSubject = findHeader(headers, "Subject") ?? ""
        const originalFrom = findHeader(headers, "From") ?? ""
        const originalMessageId = findHeader(headers, "Message-ID") ?? ""
        const originalReferences = findHeader(headers, "References") ?? ""
        const threadId = originalMessage.data.threadId

        const newReferences = originalReferences ? `${originalReferences} ${originalMessageId}` : originalMessageId
        const replySubject = originalSubject.toLowerCase().startsWith("re:")
          ? originalSubject
          : `Re: ${originalSubject}`

        const encodedMessage = encodeBase64Url(
          buildMimeMessage({
            to: originalFrom,
            subject: replySubject,
            body: input.body,
            ...(input.htmlBody !== undefined ? { htmlBody: input.htmlBody } : {}),
            ...(input.cc !== undefined ? { cc: input.cc } : {}),
            ...(input.bcc !== undefined ? { bcc: input.bcc } : {}),
            ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
            ...(originalMessageId ? { inReplyTo: originalMessageId } : {}),
            ...(newReferences ? { references: newReferences } : {}),
          }),
        )

        const response = yield* gmailWriteCall("Failed to send reply via Gmail API", (gmail) =>
          gmail.users.messages.send({
            userId: "me",
            requestBody: {
              raw: encodedMessage,
              threadId: threadId ?? null,
            },
          }),
        )

        return response.data.id ?? ""
      })

    const createDraft = (
      input: CreateDraftInput,
    ): Effect.Effect<GmailDraftInfo, GmailError | GmailConfigError | GmailAuthError> =>
      Effect.gen(function* () {
        const encodedMessage = encodeBase64Url(buildMimeMessage(input))
        const response = yield* gmailWriteCall("Failed to create draft via Gmail API", (gmail) =>
          gmail.users.drafts.create({
            userId: "me",
            requestBody: {
              message: { raw: encodedMessage },
            },
          }),
        )

        return {
          id: response.data.id ?? "",
          messageId: response.data.message?.id ?? "",
        }
      })

    const extractBody = (
      part: gmail_v1.Schema$MessagePart | undefined,
    ): { readonly text?: string; readonly html?: string } => {
      if (!part) return {}

      if (part.mimeType === "text/plain" && part.body?.data) {
        return { text: decodeBase64Url(part.body.data) }
      }
      if (part.mimeType === "text/html" && part.body?.data) {
        return { html: decodeBase64Url(part.body.data) }
      }

      if (!part.parts) return {}

      let text: string | undefined
      let html: string | undefined

      for (const child of part.parts) {
        const result = extractBody(child)
        if (!text && result.text) text = result.text
        if (!html && result.html) html = result.html
        if (text && html) break
      }

      return {
        ...(text ? { text } : {}),
        ...(html ? { html } : {}),
      }
    }

    const extractAttachments = (part: gmail_v1.Schema$MessagePart | undefined): GmailAttachmentMeta[] => {
      if (!part) return []
      const attachments: GmailAttachmentMeta[] = []

      const walk = (p: gmail_v1.Schema$MessagePart) => {
        if (p.filename && p.body?.attachmentId) {
          attachments.push({
            id: p.body.attachmentId,
            filename: p.filename,
            mimeType: p.mimeType ?? "application/octet-stream",
            size: p.body.size ?? 0,
          })
        }
        if (p.parts) {
          for (const child of p.parts) walk(child)
        }
      }

      walk(part)
      return attachments
    }

    const readMessage = (id: string): Effect.Effect<GmailMessageBody, GmailError | GmailConfigError | GmailAuthError> =>
      Effect.gen(function* () {
        const detail = yield* gmailReadCall(`Failed to retrieve Gmail message ${id}`, (gmail) =>
          gmail.users.messages.get({
            userId: "me",
            id,
            format: "full",
          }),
        )

        const headers = detail.data.payload?.headers
        const bodyParts = extractBody(detail.data.payload)
        const body = bodyParts.text ?? bodyParts.html ?? ""
        const attachments = extractAttachments(detail.data.payload)

        const message: GmailMessageBody = {
          id,
          subject: findHeader(headers, "Subject") ?? "(no subject)",
          from: findHeader(headers, "From") ?? "",
          body,
          ...(bodyParts.html ? { htmlBody: bodyParts.html } : {}),
          attachments,
        }

        const date = findHeader(headers, "Date")
        if (date) message.date = date
        if (detail.data.labelIds) {
          message.unread = detail.data.labelIds.includes("UNREAD")
        }

        return message
      })

    const getAttachment = (
      messageId: string,
      attachmentId: string,
    ): Effect.Effect<Buffer, GmailError | GmailConfigError | GmailAuthError> =>
      Effect.gen(function* () {
        const response = yield* gmailWriteCall(
          `Failed to fetch attachment ${attachmentId} from message ${messageId}`,
          (gmail) =>
            gmail.users.messages.attachments.get({
              userId: "me",
              messageId,
              id: attachmentId,
            }),
        )

        const data = response.data.data
        if (!data) {
          return yield* Effect.fail(new GmailError({ message: `Attachment ${attachmentId} has no data` }))
        }

        return decodeBase64UrlBuffer(data)
      })

    const modifyMessageLabels = (
      id: string,
      removeLabelIds: readonly string[],
    ): Effect.Effect<void, GmailError | GmailConfigError | GmailAuthError> =>
      gmailWriteCall(`Failed to update Gmail message ${id}`, (gmail) =>
        gmail.users.messages.modify({
          userId: "me",
          id,
          requestBody: { removeLabelIds: [...removeLabelIds] },
        }),
      ).pipe(Effect.asVoid)

    const archiveMessage = (id: string) => modifyMessageLabels(id, ["INBOX"])

    const trashMessage = (id: string): Effect.Effect<void, GmailError | GmailConfigError | GmailAuthError> =>
      gmailWriteCall(`Failed to move Gmail message ${id} to trash`, (gmail) =>
        gmail.users.messages.trash({ userId: "me", id }),
      ).pipe(Effect.asVoid)

    const markMessageRead = (id: string) => modifyMessageLabels(id, ["UNREAD"])

    const unsubscribeFromMessage = (
      id: string,
    ): Effect.Effect<GmailUnsubscribeResult, GmailError | GmailConfigError | GmailAuthError> =>
      Effect.gen(function* () {
        const detail = yield* gmailReadCall(`Failed to retrieve unsubscribe headers for Gmail message ${id}`, (gmail) =>
          gmail.users.messages.get({
            userId: "me",
            id,
            format: "metadata",
            metadataHeaders: ["List-Unsubscribe", "List-Unsubscribe-Post"],
          }),
        )

        const headers = detail.data.payload?.headers
        const listUnsubscribe = findHeader(headers, "List-Unsubscribe")

        if (!listUnsubscribe) {
          return yield* new GmailError({ message: `Message ${id} does not provide a List-Unsubscribe header` })
        }

        const destinations = parseListUnsubscribe(listUnsubscribe)
        const oneClick = findHeader(headers, "List-Unsubscribe-Post")
          ?.toLowerCase()
          .includes("list-unsubscribe=one-click")
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
            catch: (cause) =>
              new GmailError({
                message: `One-click unsubscribe failed for message ${id}`,
                cause,
              }),
          })
          return { method: "one-click", destination: httpsDestination.toString() }
        }

        const mailtoDestination = destinations.find((destination) => destination.protocol === "mailto:")
        if (mailtoDestination) {
          const to = decodeURIComponent(mailtoDestination.pathname)
          if (!to) {
            return yield* new GmailError({ message: `Message ${id} has an invalid mailto unsubscribe` })
          }
          yield* sendEmail({
            to,
            subject: mailtoDestination.searchParams.get("subject") ?? "unsubscribe",
            body: mailtoDestination.searchParams.get("body") ?? "unsubscribe",
          })
          return { method: "mailto", destination: to }
        }

        return yield* new GmailError({
          message: `Message ${id} only provides an interactive web unsubscribe; no one-click or mailto option is available`,
        })
      })

    const toMessageSummary = (
      messageId: string,
      stub: gmail_v1.Schema$Message,
      detail: gmail_v1.Schema$Message,
    ): GmailMessageSummary => {
      const headers = detail.payload?.headers
      const summary: GmailMessageSummary = {
        id: messageId,
        subject: findHeader(headers, "Subject") ?? "(no subject)",
        from: findHeader(headers, "From") ?? "",
        snippet: detail.snippet ?? stub.snippet ?? "",
      }

      const threadId = detail.threadId ?? stub.threadId
      if (threadId) summary.threadId = threadId
      const date = findHeader(headers, "Date")
      if (date) summary.date = date
      if (detail.labelIds) summary.unread = detail.labelIds.includes("UNREAD")
      return summary
    }

    const fetchBatchDetails = async (
      client: GmailOAuth2Client,
      chunk: readonly gmail_v1.Schema$Message[],
    ): Promise<ReadonlyMap<number, gmail_v1.Schema$Message>> => {
      const { token } = await client.getAccessToken()
      if (!token) return new Map()
      const boundary = `batch_mail_control_${Date.now()}_${Math.random().toString(36).slice(2)}`
      const parts = chunk.map((m, index) =>
        [
          `--${boundary}`,
          "Content-Type: application/http",
          `Content-ID: <item${index}>`,
          "",
          `GET /gmail/v1/users/me/messages/${encodeURIComponent(m.id ?? "")}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date&fields=id,threadId,labelIds,snippet,payload/headers HTTP/1.1`,
          "",
          "",
        ].join("\r\n"),
      )
      const body = `${parts.join("")}--${boundary}--\r\n`

      const response = await fetch("https://gmail.googleapis.com/batch/gmail/v1", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/mixed; boundary=${boundary}`,
        },
        body,
        signal: AbortSignal.timeout(GMAIL_READ_TIMEOUT_MS),
      })
      if (!response.ok) return new Map()
      const raw = await response.text()
      return parseBatchMessagesResponse(raw, response.headers.get("content-type"))
    }

    const listMessages = (
      options?: ListMessagesOptions,
    ): Effect.Effect<GmailMessageSummary[], GmailError | GmailConfigError | GmailAuthError> =>
      Effect.gen(function* () {
        const client = yield* ensureAuthorized()
        const gmail = yield* getReadGmail()
        const targetCount = Math.max(0, options?.maxResults ?? 10)
        if (targetCount === 0) return []

        const dedupeThreads = Boolean(options?.labelIds?.includes("INBOX"))
        const seenThreads = new Set<string>()
        const messages: gmail_v1.Schema$Message[] = []
        let pageToken: string | undefined

        for (let page = 0; page < 5 && messages.length < targetCount; page++) {
          const remaining = targetCount - messages.length
          const pageSize = Math.min(500, dedupeThreads && page > 0 ? Math.max(remaining * 2, 20) : remaining)
          const params: gmail_v1.Params$Resource$Users$Messages$List = {
            userId: "me",
            maxResults: pageSize,
            fields: "messages(id,threadId),nextPageToken",
          }

          if (options?.query !== undefined) params.q = options.query
          if (options?.labelIds !== undefined) params.labelIds = [...options.labelIds]
          if (pageToken !== undefined) params.pageToken = pageToken

          const listResponse = yield* Effect.tryPromise(() => gmail.users.messages.list(params)).pipe(
            Effect.mapError(
              (cause) =>
                new GmailError({
                  message: "Failed to list Gmail messages",
                  cause,
                }),
            ),
            Effect.ensuring(flushTokenSave),
          )

          const batch = listResponse.data.messages ?? []
          for (const stub of batch) {
            if (!stub.id) continue
            if (dedupeThreads) {
              const key = stub.threadId ?? stub.id
              if (seenThreads.has(key)) continue
              seenThreads.add(key)
            }
            messages.push(stub)
            if (messages.length >= targetCount) break
          }

          pageToken = listResponse.data.nextPageToken ?? undefined
          if (!pageToken || batch.length === 0) break
        }

        if (messages.length === 0) {
          return []
        }

        const batchedDetails = new Map<number, gmail_v1.Schema$Message>()
        if (messages.length > 1) {
          for (let offset = 0; offset < messages.length; offset += GMAIL_BATCH_CHUNK_SIZE) {
            const chunk = messages.slice(offset, offset + GMAIL_BATCH_CHUNK_SIZE)
            const chunkMap = yield* Effect.tryPromise(() => fetchBatchDetails(client, chunk)).pipe(
              Effect.orElseSucceed(() => new Map<number, gmail_v1.Schema$Message>()),
              Effect.ensuring(flushTokenSave),
            )
            for (const [index, detail] of chunkMap) {
              batchedDetails.set(offset + index, detail)
            }
          }
        }

        const summaries = yield* Effect.forEach(
          messages,
          (message, index) => {
            if (!message.id) return Effect.succeed(null)
            const messageId = message.id
            const fromBatch = batchedDetails.get(index)
            if (fromBatch && fromBatch.id === messageId) {
              return Effect.succeed(toMessageSummary(messageId, message, fromBatch))
            }

            return Effect.tryPromise(() =>
              gmail.users.messages.get({
                userId: "me",
                id: messageId,
                format: "metadata",
                metadataHeaders: ["Subject", "From", "Date"],
                fields: "id,threadId,labelIds,snippet,payload/headers",
              }),
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new GmailError({
                    message: `Failed to retrieve Gmail message ${messageId}`,
                    cause,
                  }),
              ),
              Effect.map((detail) => toMessageSummary(messageId, message, detail.data)),
            )
          },
          { concurrency: GMAIL_FALLBACK_CONCURRENCY },
        ).pipe(Effect.ensuring(flushTokenSave))

        return summaries.filter((summary) => summary !== null)
      })

    const listLabels = (): Effect.Effect<GmailLabel[], GmailError | GmailConfigError | GmailAuthError> =>
      Effect.gen(function* () {
        const response = yield* gmailReadCall("Failed to list Gmail labels", (gmail) =>
          gmail.users.labels.list({ userId: "me" }),
        )
        return (response.data.labels ?? []).flatMap((label) =>
          label.id && label.name
            ? [{ id: label.id, name: label.name, ...(present(label.type) ? { type: label.type } : {}) }]
            : [],
        )
      })

    const createLabel = (name: string): Effect.Effect<GmailLabel, GmailError | GmailConfigError | GmailAuthError> =>
      Effect.gen(function* () {
        const response = yield* gmailWriteCall(`Failed to create Gmail label "${name}"`, (gmail) =>
          gmail.users.labels.create({
            userId: "me",
            requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
          }),
        )
        return { id: response.data.id ?? "", name: response.data.name ?? name, type: response.data.type ?? "user" }
      })

    const missingSettingsScope = (cause?: unknown) =>
      new GmailScopeError({
        message: `Gmail token is missing the ${GMAIL_SETTINGS_SCOPE} scope required to manage filters`,
        scope: GMAIL_SETTINGS_SCOPE,
        ...(cause !== undefined ? { cause } : {}),
      })

    // Fail before any request when the stored token says the settings scope was
    // never granted, so `create` doesn't leave a new label behind.
    const settingsClient = (): Effect.Effect<
      gmail_v1.Gmail,
      GmailError | GmailConfigError | GmailAuthError | GmailScopeError
    > =>
      Effect.gen(function* () {
        const client = yield* ensureAuthorized()
        if (lacksGrantedScope(client.credentials.scope, GMAIL_SETTINGS_SCOPE)) {
          return yield* missingSettingsScope()
        }
        return yield* getReadGmail()
      })

    const settingsRequest = <A>(message: string, request: () => Promise<A>) =>
      Effect.tryPromise({
        try: request,
        catch: (cause) =>
          isInsufficientScopeError(cause) ? missingSettingsScope(cause) : new GmailError({ message, cause }),
      }).pipe(Effect.ensuring(flushTokenSave))

    const listFilters = (): Effect.Effect<
      GmailFilter[],
      GmailError | GmailConfigError | GmailAuthError | GmailScopeError
    > =>
      Effect.gen(function* () {
        const gmail = yield* settingsClient()
        const response = yield* settingsRequest("Failed to list Gmail filters", () =>
          gmail.users.settings.filters.list({ userId: "me" }),
        )
        return (response.data.filter ?? []).map(toGmailFilter)
      })

    const createFilter = (
      input: GmailFilterInput,
    ): Effect.Effect<GmailFilter, GmailError | GmailConfigError | GmailAuthError | GmailScopeError> =>
      Effect.gen(function* () {
        const gmail = yield* settingsClient()
        const response = yield* settingsRequest("Failed to create Gmail filter", () =>
          gmail.users.settings.filters.create({ userId: "me", requestBody: input }),
        )
        return toGmailFilter(response.data)
      })

    const deleteFilter = (
      id: string,
    ): Effect.Effect<void, GmailError | GmailConfigError | GmailAuthError | GmailScopeError> =>
      Effect.gen(function* () {
        const gmail = yield* settingsClient()
        yield* settingsRequest(`Failed to delete Gmail filter ${id}`, () =>
          gmail.users.settings.filters.delete({ userId: "me", id }),
        )
      })

    return {
      authorize: ensureAuthorized,
      sendEmail,
      replyToEmail,
      createDraft,
      readMessage,
      listMessages,
      getAttachment,
      archiveMessage,
      trashMessage,
      markMessageRead,
      unsubscribeFromMessage,
      listLabels,
      createLabel,
      listFilters,
      createFilter,
      deleteFilter,
    } as const
  })

/**
 * Singleton Gmail service that reads configuration from environment variables.
 * For multi-account support, use `makeGmailService` instead.
 */
export class GmailService extends Context.Service<GmailService>()("@mail-control/gmail/GmailService", {
  make: Effect.gen(function* () {
    const config = yield* GmailConfig
    return yield* makeGmailService({
      credentialsPath: config.credentialsPath,
      tokenPath: config.tokenPath,
      scopes: config.scopes,
    })
  }),
}) {
  static readonly layer = Layer.effect(this)(this.make).pipe(Layer.provide(GmailConfig.layer))
}
