import path from "node:path"
import { Config, Context, Effect, FileSystem, Layer, Option, Redacted, Schema } from "effect"
import { Accounts, type ResolvedAccount, readJsonFile } from "./config.js"
import { MailConfigError, mailConfigError } from "./errors.js"

/**
 * Shape of `~/.mail-control/secrets.json` (written 0600). Secrets never live in
 * `config.json` so that the identity config stays safe to share or commit.
 */
export const SecretsFile = Schema.Struct({
  accounts: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        appPassword: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
})
export type SecretsFile = Schema.Schema.Type<typeof SecretsFile>

/** The env var consulted for an account's app password (override or derived). */
export const appPasswordEnvVar = (account: ResolvedAccount): string =>
  account.config.type === "icloud" && account.config.appPasswordEnv !== undefined
    ? account.config.appPasswordEnv
    : `MAIL_${account.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_APP_PASSWORD`

export interface SecretsInterface {
  /** Resolve an account's app password: env var, then the 0600 secrets file. */
  readonly appPassword: (account: ResolvedAccount) => Effect.Effect<Redacted.Redacted<string>, MailConfigError>
  /** Absolute path of the secrets file. */
  readonly secretsPath: string
}

/**
 * Resolves per-account secrets through an ordered chain so users are never
 * forced to use env vars: env (override, good for CI) then the 0600 secrets
 * file (the default store). An OS keychain provider can slot in as a later step.
 */
export class Secrets extends Context.Service<Secrets, SecretsInterface>()("mail-control/Secrets") {}

export const layer = Layer.effect(
  Secrets,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const accounts = yield* Accounts
    const secretsPath = path.join(accounts.dir, "secrets.json")

    // Load the secrets file once; an absent file is fine (env may supply secrets).
    const exists = yield* fs.exists(secretsPath).pipe(Effect.orElseSucceed(() => false))
    const fileSecrets = exists
      ? yield* readJsonFile(secretsPath, SecretsFile, "secrets")
      : ({ accounts: {} } satisfies SecretsFile)

    const appPassword = (account: ResolvedAccount): Effect.Effect<Redacted.Redacted<string>, MailConfigError> =>
      Effect.gen(function* () {
        const envName = appPasswordEnvVar(account)
        const fromEnv = yield* Config.option(Config.redacted(envName)).pipe(
          Effect.mapError(mailConfigError(`Failed to read env ${envName}`)),
        )
        if (Option.isSome(fromEnv)) return fromEnv.value

        const fromFile = fileSecrets.accounts?.[account.id]?.appPassword
        if (fromFile !== undefined && fromFile.length > 0) return Redacted.make(fromFile)

        return yield* Effect.fail(
          new MailConfigError({
            message: `No app password for "${account.id}". Set ${envName} or add it to ${secretsPath}.`,
          }),
        )
      })

    return Secrets.of({ appPassword, secretsPath })
  }),
)
