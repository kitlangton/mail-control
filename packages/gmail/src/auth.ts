import { exec } from "node:child_process"
import fs from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import readline from "node:readline/promises"
import { Console, Effect } from "effect"
import { google } from "googleapis"
import { GmailAuthError, GmailConfigError } from "./types.js"

/**
 * Scopes mail-control needs: send, modify (archive/trash/mark-read/labels), and
 * compose. Must stay in sync with the service's default scopes so a token minted
 * here can perform every supported operation.
 */
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
] as const

const DEFAULT_PORT = 8374

export interface AuthorizeGmailOptions {
  readonly credentialsPath: string
  readonly tokenPath: string
  /** Print a URL and read a pasted code instead of opening a local browser (for headless machines). */
  readonly manual?: boolean
  readonly scopes?: readonly string[]
  readonly port?: number
}

const readClientInfo = (
  credentialsPath: string,
): Effect.Effect<{ clientId: string; clientSecret: string }, GmailConfigError> =>
  Effect.tryPromise({
    try: async () => {
      const raw = await fs.readFile(credentialsPath, "utf8")
      const parsed = JSON.parse(raw) as {
        installed?: { client_id?: string; client_secret?: string }
        web?: { client_id?: string; client_secret?: string }
      }
      const oauth = parsed.installed ?? parsed.web
      if (!oauth?.client_id || !oauth?.client_secret) {
        throw new GmailConfigError({
          message: `Credentials at ${credentialsPath} are missing an installed/web client_id and client_secret`,
        })
      }
      return { clientId: oauth.client_id, clientSecret: oauth.client_secret }
    },
    catch: (cause) =>
      cause instanceof GmailConfigError
        ? cause
        : new GmailConfigError({ message: `Failed to read Gmail credentials at ${credentialsPath}`, cause }),
  })

const openBrowser = (url: string): void => {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
  exec(`${command} "${url}"`)
}

const promptLine = (prompt: string): Effect.Effect<string, GmailAuthError> =>
  Effect.tryPromise({
    try: async () => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      try {
        return (await rl.question(prompt)).trim()
      } finally {
        rl.close()
      }
    },
    catch: (cause) => new GmailAuthError({ message: "Failed to read authorization code", cause }),
  })

const waitForCodeViaBrowser = (authUrl: string, port: number): Effect.Effect<string, GmailAuthError> =>
  Effect.callback<string, GmailAuthError>((resume) => {
    const server = createServer((req, res) => {
      const code = new URL(req.url ?? "/", `http://localhost:${port}`).searchParams.get("code")
      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" })
        res.end("<h1>Authorized</h1><p>You can close this tab and return to the terminal.</p>")
        server.close()
        resume(Effect.succeed(code))
      } else {
        res.writeHead(400, { "Content-Type": "text/html" })
        res.end("<h1>No authorization code received</h1>")
      }
    })
    server.on("error", (cause) =>
      resume(Effect.fail(new GmailAuthError({ message: "Local authorization server failed to start", cause }))),
    )
    server.listen(port, () => openBrowser(authUrl))
    return Effect.sync(() => server.close())
  })

const writeToken = (tokenPath: string, tokens: unknown): Effect.Effect<void, GmailAuthError> =>
  Effect.tryPromise({
    try: async () => {
      await fs.mkdir(path.dirname(tokenPath), { recursive: true })
      await fs.writeFile(tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 })
    },
    catch: (cause) => new GmailAuthError({ message: `Failed to write token to ${tokenPath}`, cause }),
  })

/**
 * Runs the Gmail OAuth flow for one account and writes the token to `tokenPath`.
 * Defaults to a local-browser flow; `manual: true` prints a URL and reads a
 * pasted code (for headless machines with no browser).
 */
export const authorizeGmail = (opts: AuthorizeGmailOptions): Effect.Effect<void, GmailConfigError | GmailAuthError> =>
  Effect.gen(function* () {
    const scopes = [...(opts.scopes ?? GMAIL_SCOPES)]
    const port = opts.port ?? DEFAULT_PORT
    const { clientId, clientSecret } = yield* readClientInfo(opts.credentialsPath)

    const redirectUri = opts.manual ? "http://localhost" : `http://localhost:${port}`
    const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri)
    const authUrl = client.generateAuthUrl({ access_type: "offline", scope: scopes, prompt: "consent" })

    let code: string
    if (opts.manual) {
      yield* Console.log("Open this URL, authorize, then copy the `code` value from the redirected URL bar:\n")
      yield* Console.log(`${authUrl}\n`)
      code = yield* promptLine("Authorization code: ")
    } else {
      yield* Console.log(`Opening your browser to authorize (listening on http://localhost:${port})...`)
      yield* Console.log(`If it didn't open, visit:\n${authUrl}\n`)
      code = yield* waitForCodeViaBrowser(authUrl, port)
    }

    const result = yield* Effect.tryPromise({
      try: () => client.getToken(code),
      catch: (cause) => new GmailAuthError({ message: "Failed to exchange authorization code for a token", cause }),
    })

    if (!result.tokens) {
      return yield* Effect.fail(new GmailAuthError({ message: "Authorization returned no tokens" }))
    }

    yield* writeToken(opts.tokenPath, result.tokens)
  })
