import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import readline from "node:readline/promises"
import { Config, Console, Context, Effect, Layer, Option, Redacted } from "effect"
import { type gmail_v1, google } from "googleapis"
import { defaultGmailCredentialsPath, defaultGmailTokenPath } from "./paths.js"
import type {
  CreateDraftInput,
  GmailAttachmentMeta,
  GmailDraftInfo,
  GmailMessageBody,
  GmailMessageSummary,
  GmailUnsubscribeResult,
  ListMessagesOptions,
  ReplyEmailInput,
  SendEmailInput,
} from "./types.js"
import { GmailAuthError, GmailConfigError, GmailError } from "./types.js"

const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
]
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

interface CredentialsFile {
  installed?: {
    client_id: string
    client_secret: string
    redirect_uris?: string[]
  }
  web?: {
    client_id: string
    client_secret: string
    redirect_uris?: string[]
  }
}

export class GmailConfig extends Context.Service<GmailConfig>()("@mail-control/gmail/GmailConfig", {
  make: Effect.gen(function* () {
    const credentialsPath = yield* Config.string("GOOGLE_CLIENT_SECRET_PATH").pipe(
      Config.orElse(() => Config.succeed(defaultGmailCredentialsPath())),
    )
    const tokenPathOption = yield* Config.option(Config.string("GOOGLE_TOKEN_PATH"))
    const scopesOption = yield* Config.option(Config.redacted("GOOGLE_SCOPES"))

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

const loadCredentials = (credentialsPath: string): Effect.Effect<CredentialsFile, GmailConfigError> =>
  Effect.tryPromise({
    try: async () => {
      let raw: string
      try {
        raw = await fs.readFile(credentialsPath, "utf8")
      } catch (cause) {
        throw new GmailConfigError({
          message: `Failed to read credentials file at ${credentialsPath}`,
          cause,
        })
      }

      try {
        return JSON.parse(raw) as CredentialsFile
      } catch (cause) {
        throw new GmailConfigError({
          message: `Failed to parse credentials JSON at ${credentialsPath}`,
          cause,
        })
      }
    },
    catch: (cause) =>
      cause instanceof GmailConfigError
        ? cause
        : new GmailConfigError({
            message: `Unexpected error loading credentials from ${credentialsPath}`,
            cause,
          }),
  })

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

      const payload = JSON.stringify(credentials, null, 2)

      try {
        await fs.writeFile(tokenPath, payload, "utf8")
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

const promptForCode = (prompt: string): Effect.Effect<string, GmailAuthError> =>
  Effect.tryPromise({
    try: async () => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      })
      try {
        return await rl.question(prompt)
      } finally {
        rl.close()
      }
    },
    catch: (cause) =>
      cause instanceof GmailAuthError
        ? cause
        : new GmailAuthError({
            message: "Failed to read authorization code from stdin",
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

    const buildClient = (): Effect.Effect<GmailOAuth2Client, GmailConfigError | GmailError | GmailAuthError> =>
      Effect.gen(function* () {
        const credentials = yield* loadCredentials(config.credentialsPath)
        const oauthConfig = credentials.installed ?? credentials.web

        if (!oauthConfig) {
          return yield* Effect.fail(
            new GmailConfigError({
              message: "credentials file must contain an 'installed' or 'web' client configuration",
            }),
          )
        }

        const { client_id: clientId, client_secret: clientSecret, redirect_uris: redirectUris } = oauthConfig

        if (!clientId || !clientSecret) {
          return yield* Effect.fail(
            new GmailConfigError({
              message: "credentials file is missing client_id or client_secret",
            }),
          )
        }

        const redirectUri = redirectUris?.[0]
        const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri)

        const existingToken = yield* readTokenIfExists(config.tokenPath)
        if (Option.isSome(existingToken)) {
          client.setCredentials(existingToken.value)

          client.on("tokens", (tokens) => {
            const refreshToken = tokens.refresh_token ?? existingToken.value.refresh_token ?? null
            const merged: OAuth2Credentials = {
              ...existingToken.value,
              ...tokens,
              refresh_token: refreshToken,
            }
            saveToken(config.tokenPath, merged).pipe(Effect.runPromise)
          })

          return client
        }

        const authUrl = client.generateAuthUrl({
          access_type: "offline",
          scope: config.scopes,
        })

        yield* Console.log("Authorize this app by visiting the following URL:")
        yield* Console.log(authUrl)

        const code = yield* promptForCode("Enter the code from that page here: ")

        const { tokens } = yield* Effect.tryPromise({
          try: () => client.getToken(code),
          catch: (cause) =>
            new GmailAuthError({
              message: "Failed to retrieve access token from Google",
              cause,
            }),
        })

        if (!tokens) {
          return yield* Effect.fail(
            new GmailAuthError({
              message: "Authorization succeeded but no tokens were returned",
            }),
          )
        }

        client.setCredentials(tokens)
        yield* saveToken(config.tokenPath, tokens)
        yield* Console.log(`Token stored to ${config.tokenPath}`)

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

    const encodeHeaderValue = (value: string): string => {
      if ([...value].every((character) => character.charCodeAt(0) <= 0x7f)) return value
      const encoded = Buffer.from(value, "utf-8").toString("base64")
      return `=?UTF-8?B?${encoded}?=`
    }

    const buildMimeMessage = (input: SendEmailInput): string => {
      const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`
      const hasAttachments = Array.isArray(input.attachments) && input.attachments.length > 0
      const hasHtml = input.htmlBody !== undefined

      const headers = [
        `To: ${input.to}`,
        ...(input.cc ? [`Cc: ${input.cc}`] : []),
        ...(input.bcc ? [`Bcc: ${input.bcc}`] : []),
        `Subject: ${encodeHeaderValue(input.subject)}`,
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
        const client = yield* ensureAuthorized()
        const gmail = google.gmail({ version: "v1", auth: client })

        const message = buildMimeMessage(input)
        const encodedMessage = Buffer.from(message)
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "")

        const response = yield* Effect.tryPromise({
          try: () =>
            gmail.users.messages.send({
              userId: "me",
              requestBody: { raw: encodedMessage },
            }),
          catch: (cause) =>
            new GmailError({
              message: "Failed to send email via Gmail API",
              cause,
            }),
        })

        return response.data.id ?? ""
      })

    const replyToEmail = (
      input: ReplyEmailInput,
    ): Effect.Effect<string, GmailError | GmailConfigError | GmailAuthError> =>
      Effect.gen(function* () {
        const client = yield* ensureAuthorized()
        const gmail = google.gmail({ version: "v1", auth: client })

        const originalMessage = yield* Effect.tryPromise(() =>
          gmail.users.messages.get({
            userId: "me",
            id: input.messageId,
            format: "metadata",
            metadataHeaders: ["Subject", "From", "To", "Message-ID", "References"],
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new GmailError({
                message: `Failed to retrieve original message ${input.messageId}`,
                cause,
              }),
          ),
        )

        const headers = originalMessage.data.payload?.headers ?? []
        const findHeader = (name: string): string | undefined =>
          headers.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined

        const originalSubject = findHeader("Subject") ?? ""
        const originalFrom = findHeader("From") ?? ""
        const originalMessageId = findHeader("Message-ID") ?? ""
        const originalReferences = findHeader("References") ?? ""
        const threadId = originalMessage.data.threadId

        const newReferences = originalReferences ? `${originalReferences} ${originalMessageId}` : originalMessageId

        const replySubject = originalSubject.toLowerCase().startsWith("re:")
          ? originalSubject
          : `Re: ${originalSubject}`

        const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`
        const hasAttachments = Array.isArray(input.attachments) && input.attachments.length > 0

        const replyHeaders = [
          `To: ${originalFrom}`,
          ...(input.cc ? [`Cc: ${input.cc}`] : []),
          ...(input.bcc ? [`Bcc: ${input.bcc}`] : []),
          `Subject: ${encodeHeaderValue(replySubject)}`,
          `In-Reply-To: ${originalMessageId}`,
          `References: ${newReferences}`,
          "MIME-Version: 1.0",
          hasAttachments
            ? `Content-Type: multipart/mixed; boundary="${boundary}"`
            : "Content-Type: text/plain; charset=utf-8",
          "",
        ]

        let rawMessage: string
        if (!hasAttachments) {
          rawMessage = [...replyHeaders, input.body].join("\r\n")
        } else {
          const parts: string[] = [
            ...replyHeaders,
            "",
            `--${boundary}`,
            "Content-Type: text/plain; charset=utf-8",
            "",
            input.body,
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
          rawMessage = parts.join("\r\n")
        }

        const encodedMessage = Buffer.from(rawMessage)
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "")

        const response = yield* Effect.tryPromise({
          try: () =>
            gmail.users.messages.send({
              userId: "me",
              requestBody: {
                raw: encodedMessage,
                threadId: threadId ?? null,
              },
            }),
          catch: (cause) =>
            new GmailError({
              message: "Failed to send reply via Gmail API",
              cause,
            }),
        })

        return response.data.id ?? ""
      })

    const createDraft = (
      input: CreateDraftInput,
    ): Effect.Effect<GmailDraftInfo, GmailError | GmailConfigError | GmailAuthError> =>
      Effect.gen(function* () {
        const client = yield* ensureAuthorized()
        const gmail = google.gmail({ version: "v1", auth: client })

        const message = buildMimeMessage(input)
        const encodedMessage = Buffer.from(message)
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "")

        const response = yield* Effect.tryPromise({
          try: () =>
            gmail.users.drafts.create({
              userId: "me",
              requestBody: {
                message: { raw: encodedMessage },
              },
            }),
          catch: (cause) =>
            new GmailError({
              message: "Failed to create draft via Gmail API",
              cause,
            }),
        })

        return {
          id: response.data.id ?? "",
          messageId: response.data.message?.id ?? "",
        }
      })

    const decodeBase64Url = (value: string): string =>
      Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")

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
        const client = yield* ensureAuthorized()
        const gmail = google.gmail({ version: "v1", auth: client })

        const detail = yield* Effect.tryPromise(() =>
          gmail.users.messages.get({
            userId: "me",
            id,
            format: "full",
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new GmailError({
                message: `Failed to retrieve Gmail message ${id}`,
                cause,
              }),
          ),
        )

        const headers = detail.data.payload?.headers ?? []
        const findHeader = (name: string): string | undefined =>
          headers.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined

        const bodyParts = extractBody(detail.data.payload)
        const body = bodyParts.text ?? bodyParts.html ?? ""
        const attachments = extractAttachments(detail.data.payload)

        const message: GmailMessageBody = {
          id,
          subject: findHeader("Subject") ?? "(no subject)",
          from: findHeader("From") ?? "",
          body,
          ...(bodyParts.html ? { htmlBody: bodyParts.html } : {}),
          attachments,
        }

        const date = findHeader("Date")
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
        const client = yield* ensureAuthorized()
        const gmail = google.gmail({ version: "v1", auth: client })

        const response = yield* Effect.tryPromise(() =>
          gmail.users.messages.attachments.get({
            userId: "me",
            messageId,
            id: attachmentId,
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new GmailError({
                message: `Failed to fetch attachment ${attachmentId} from message ${messageId}`,
                cause,
              }),
          ),
        )

        const data = response.data.data
        if (!data) {
          return yield* Effect.fail(new GmailError({ message: `Attachment ${attachmentId} has no data` }))
        }

        return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64")
      })

    const modifyMessageLabels = (
      id: string,
      removeLabelIds: readonly string[],
    ): Effect.Effect<void, GmailError | GmailConfigError | GmailAuthError> =>
      Effect.gen(function* () {
        const client = yield* ensureAuthorized()
        const gmail = google.gmail({ version: "v1", auth: client })

        yield* Effect.tryPromise({
          try: () =>
            gmail.users.messages.modify({
              userId: "me",
              id,
              requestBody: { removeLabelIds: [...removeLabelIds] },
            }),
          catch: (cause) =>
            new GmailError({
              message: `Failed to update Gmail message ${id}`,
              cause,
            }),
        })
      })

    const archiveMessage = (id: string) => modifyMessageLabels(id, ["INBOX"])

    const trashMessage = (id: string): Effect.Effect<void, GmailError | GmailConfigError | GmailAuthError> =>
      Effect.gen(function* () {
        const client = yield* ensureAuthorized()
        const gmail = google.gmail({ version: "v1", auth: client })

        yield* Effect.tryPromise({
          try: () => gmail.users.messages.trash({ userId: "me", id }),
          catch: (cause) =>
            new GmailError({
              message: `Failed to move Gmail message ${id} to trash`,
              cause,
            }),
        })
      })

    const markMessageRead = (id: string) => modifyMessageLabels(id, ["UNREAD"])

    const unsubscribeFromMessage = (
      id: string,
    ): Effect.Effect<GmailUnsubscribeResult, GmailError | GmailConfigError | GmailAuthError> =>
      Effect.gen(function* () {
        const client = yield* ensureAuthorized()
        const gmail = google.gmail({ version: "v1", auth: client })
        const detail = yield* Effect.tryPromise({
          try: () =>
            gmail.users.messages.get({
              userId: "me",
              id,
              format: "metadata",
              metadataHeaders: ["List-Unsubscribe", "List-Unsubscribe-Post"],
            }),
          catch: (cause) =>
            new GmailError({
              message: `Failed to retrieve unsubscribe headers for Gmail message ${id}`,
              cause,
            }),
        })

        const headers = detail.data.payload?.headers ?? []
        const findHeader = (name: string): string | undefined =>
          headers.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined
        const listUnsubscribe = findHeader("List-Unsubscribe")

        if (!listUnsubscribe) {
          return yield* new GmailError({ message: `Message ${id} does not provide a List-Unsubscribe header` })
        }

        const destinations = parseListUnsubscribe(listUnsubscribe)
        const oneClick = findHeader("List-Unsubscribe-Post")?.toLowerCase().includes("list-unsubscribe=one-click")
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

    const listMessages = (
      options?: ListMessagesOptions,
    ): Effect.Effect<GmailMessageSummary[], GmailError | GmailConfigError | GmailAuthError> =>
      Effect.gen(function* () {
        const client = yield* ensureAuthorized()
        const gmail = google.gmail({ version: "v1", auth: client })

        const params: gmail_v1.Params$Resource$Users$Messages$List = {
          userId: "me",
          maxResults: options?.maxResults ?? 10,
        }

        if (options?.query !== undefined) params.q = options.query
        if (options?.labelIds !== undefined) params.labelIds = [...options.labelIds]

        const listResponse = yield* Effect.tryPromise(() => gmail.users.messages.list(params)).pipe(
          Effect.mapError(
            (cause) =>
              new GmailError({
                message: "Failed to list Gmail messages",
                cause,
              }),
          ),
        )

        const messages = listResponse.data.messages ?? []
        if (messages.length === 0) {
          return []
        }

        const summaries: GmailMessageSummary[] = []

        for (const message of messages) {
          if (!message.id) continue
          const messageId = message.id

          const detail = yield* Effect.tryPromise(() =>
            gmail.users.messages.get({
              userId: "me",
              id: messageId,
              format: "metadata",
              metadataHeaders: ["Subject", "From", "Date"],
            }),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new GmailError({
                  message: `Failed to retrieve Gmail message ${messageId}`,
                  cause,
                }),
            ),
          )

          const headers = detail.data.payload?.headers ?? []
          const findHeader = (name: string): string | undefined =>
            headers.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined

          const summary: GmailMessageSummary = {
            id: messageId,
            subject: findHeader("Subject") ?? "(no subject)",
            from: findHeader("From") ?? "",
          }

          const threadId = detail.data.threadId ?? message.threadId
          if (threadId) summary.threadId = threadId
          const date = findHeader("Date")
          if (date) summary.date = date
          const snippet = detail.data.snippet ?? message.snippet
          if (snippet) summary.snippet = snippet
          if (detail.data.labelIds) {
            summary.unread = detail.data.labelIds.includes("UNREAD")
          }

          summaries.push(summary)
        }

        return summaries
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
