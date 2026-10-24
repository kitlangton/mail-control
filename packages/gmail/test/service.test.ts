import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ConfigProvider, Effect } from "effect"
import { describe, expect, it } from "vitest"
import { defaultGmailTokenPath } from "../src/paths"
import {
  GmailConfig,
  isInsufficientScopeError,
  lacksGrantedScope,
  makeGmailService,
  parseBatchMessagesResponse,
  parseListUnsubscribe,
} from "../src/service"
import { GmailAuthError, GmailConfigError } from "../src/types"

const DEFAULT_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"
const DEFAULT_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose"
const SETTINGS_SCOPE = "https://www.googleapis.com/auth/gmail.settings.basic"

describe("GmailConfig", () => {
  it("provides sensible defaults", async () => {
    const credentialsPath = path.join(process.cwd(), "gmail-test-credentials.json")

    const program = Effect.gen(function* () {
      const config = yield* GmailConfig
      return config
    }).pipe(
      Effect.provide(GmailConfig.layer),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            GOOGLE_CLIENT_SECRET_PATH: credentialsPath,
          }),
        ),
      ),
    )

    const result = await Effect.runPromise(program)
    expect(result.credentialsPath).toBe(credentialsPath)
    expect(result.tokenPath).toBe(defaultGmailTokenPath(credentialsPath))
    expect(result.scopes).toEqual([
      DEFAULT_SEND_SCOPE,
      "https://www.googleapis.com/auth/gmail.modify",
      DEFAULT_COMPOSE_SCOPE,
      SETTINGS_SCOPE,
    ])
  })

  it("derives token paths from named credentials files", () => {
    const credentialsPath = path.join(process.cwd(), "google-credentials-work.json")

    expect(defaultGmailTokenPath(credentialsPath)).toBe(path.join(process.cwd(), "gmail-token-work.json"))
  })

  it("parses custom scopes", async () => {
    const credentialsPath = path.join(process.cwd(), "gmail-test-credentials.json")
    const customScopes = `${DEFAULT_SEND_SCOPE}, https://www.googleapis.com/auth/gmail.modify`

    const program = Effect.gen(function* () {
      const config = yield* GmailConfig
      return config
    }).pipe(
      Effect.provide(GmailConfig.layer),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            GOOGLE_CLIENT_SECRET_PATH: credentialsPath,
            GOOGLE_SCOPES: customScopes,
          }),
        ),
      ),
    )

    const result = await Effect.runPromise(program)
    expect(result.scopes).toEqual([DEFAULT_SEND_SCOPE, "https://www.googleapis.com/auth/gmail.modify"])
  })

  it("fails when scopes are empty", async () => {
    const credentialsPath = path.join(process.cwd(), "gmail-test-credentials.json")

    const program = Effect.gen(function* () {
      const config = yield* GmailConfig
      return config
    }).pipe(
      Effect.provide(GmailConfig.layer),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            GOOGLE_CLIENT_SECRET_PATH: credentialsPath,
            GOOGLE_SCOPES: "   ",
          }),
        ),
      ),
    )

    await expect(Effect.runPromise(Effect.flip(program))).resolves.toBeInstanceOf(GmailConfigError)
  })
})

describe("parseListUnsubscribe", () => {
  it("parses multiple angle-bracket destinations", () => {
    const result = parseListUnsubscribe(
      "<mailto:unsubscribe@example.com?subject=unsubscribe>, <https://example.com/unsubscribe/abc>",
    )

    expect(result.map(String)).toEqual([
      "mailto:unsubscribe@example.com?subject=unsubscribe",
      "https://example.com/unsubscribe/abc",
    ])
  })

  it("ignores malformed destinations", () => {
    expect(parseListUnsubscribe("not a url, https://example.com/unsubscribe").map(String)).toEqual([
      "https://example.com/unsubscribe",
    ])
  })
})

describe("scope detection", () => {
  it("recognizes Gmail's insufficient-scope 403", () => {
    expect(
      isInsufficientScopeError({
        status: 403,
        message: "Request had insufficient authentication scopes.",
        errors: [{ reason: "insufficientPermissions", domain: "global" }],
      }),
    ).toBe(true)
    expect(
      isInsufficientScopeError({
        response: {
          status: 403,
          data: { error: { code: 403, details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } },
        },
      }),
    ).toBe(true)
  })

  it("ignores other failures", () => {
    expect(isInsufficientScopeError({ status: 403, message: "Rate limit exceeded" })).toBe(false)
    expect(isInsufficientScopeError({ status: 400, message: "Invalid label SPAM in AddLabelIds" })).toBe(false)
    expect(isInsufficientScopeError(new Error("network down"))).toBe(false)
  })

  it("checks a token's granted scopes when known", () => {
    const granted = `${DEFAULT_SEND_SCOPE} https://www.googleapis.com/auth/gmail.modify`
    expect(lacksGrantedScope(granted, SETTINGS_SCOPE)).toBe(true)
    expect(lacksGrantedScope(`${granted} ${SETTINGS_SCOPE}`, SETTINGS_SCOPE)).toBe(false)
    expect(lacksGrantedScope(undefined, SETTINGS_SCOPE)).toBe(false)
  })
})

describe("makeGmailService", () => {
  it("fails immediately with GmailAuthError when the token file is missing instead of prompting on stdin", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mail-control-gmail-test-"))
    try {
      const credentialsPath = path.join(dir, "credentials.json")
      const tokenPath = path.join(dir, "missing-token.json")
      await writeFile(
        credentialsPath,
        JSON.stringify({
          installed: { client_id: "id", client_secret: "secret", redirect_uris: ["http://localhost"] },
        }),
        "utf8",
      )

      const service = await Effect.runPromise(makeGmailService({ credentialsPath, tokenPath }))
      const error = await Effect.runPromise(Effect.flip(service.listMessages({ maxResults: 1 })))

      expect(error).toBeInstanceOf(GmailAuthError)
      expect(error.message).toContain("Missing OAuth token")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("parseBatchMessagesResponse", () => {
  it("extracts HTTP 200 message payloads keyed by Content-ID index", () => {
    const raw = [
      "--batch_abc",
      "Content-Type: application/http",
      "Content-ID: <response-item1>",
      "",
      "HTTP/1.1 200 OK",
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify({ id: "msg-2", snippet: "Second" }),
      "--batch_abc",
      "Content-Type: application/http",
      "Content-ID: <response-item0>",
      "",
      "HTTP/1.1 200 OK",
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify({ id: "msg-1", snippet: "First" }),
      "--batch_abc--",
      "",
    ].join("\r\n")

    const parsed = parseBatchMessagesResponse(raw, "multipart/mixed; boundary=batch_abc")
    expect(parsed.get(0)?.id).toBe("msg-1")
    expect(parsed.get(1)?.id).toBe("msg-2")
  })
})
