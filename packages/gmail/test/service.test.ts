import path from "node:path"
import { ConfigProvider, Effect } from "effect"
import { describe, expect, it } from "vitest"
import { defaultGmailTokenPath } from "../src/paths"
import { GmailConfig, parseListUnsubscribe } from "../src/service"
import { GmailConfigError } from "../src/types"

const DEFAULT_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"
const DEFAULT_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose"

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
