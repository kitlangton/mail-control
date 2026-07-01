import os from "node:os"
import path from "node:path"
import { Config, Context, Effect, FileSystem, Layer, Schema } from "effect"
import { MailConfigError, mailConfigError } from "./errors.js"

/**
 * A user-chosen account identifier (the key in the `accounts` map of
 * `config.json`). Branded so it can't be confused with an arbitrary string.
 */
export const AccountId = Schema.String.pipe(Schema.brand("AccountId"))
export type AccountId = Schema.Schema.Type<typeof AccountId>

/** The provider kinds mail-control knows how to talk to. */
export const AccountType = Schema.Literals(["gmail", "icloud"])
export type AccountType = Schema.Schema.Type<typeof AccountType>

/**
 * A Gmail-backed account. Credentials/token default to
 * `<dir>/<id>-credentials.json` and `<dir>/<id>-token.json`, overridable here.
 */
export const GmailAccountConfig = Schema.Struct({
  type: Schema.Literal("gmail"),
  credentialsPath: Schema.optionalKey(Schema.String),
  tokenPath: Schema.optionalKey(Schema.String),
})
export interface GmailAccountConfig extends Schema.Schema.Type<typeof GmailAccountConfig> {}

/**
 * An iCloud-backed account. The app password is never stored here; it is
 * resolved at runtime (see `secrets.ts`) from env or the 0600 secrets file.
 */
export const ICloudAccountConfig = Schema.Struct({
  type: Schema.Literal("icloud"),
  email: Schema.String,
  /** Override the env var consulted for this account's app password. */
  appPasswordEnv: Schema.optionalKey(Schema.String),
  imapHost: Schema.optionalKey(Schema.String),
  imapPort: Schema.optionalKey(Schema.Number),
  imapSecure: Schema.optionalKey(Schema.Boolean),
  smtpHost: Schema.optionalKey(Schema.String),
  smtpPort: Schema.optionalKey(Schema.Number),
  smtpSecure: Schema.optionalKey(Schema.Boolean),
  mailbox: Schema.optionalKey(Schema.String),
})
export interface ICloudAccountConfig extends Schema.Schema.Type<typeof ICloudAccountConfig> {}

/** A single account's configuration, discriminated on `type`. */
export const AccountConfig = Schema.Union([GmailAccountConfig, ICloudAccountConfig]).annotate({
  discriminator: "type",
  identifier: "AccountConfig",
})
export type AccountConfig = Schema.Schema.Type<typeof AccountConfig>

/** The shape of `~/.mail-control/config.json`. */
export const MailConfigFile = Schema.Struct({
  accounts: Schema.Record(AccountId, AccountConfig),
})
export type MailConfigFile = Schema.Schema.Type<typeof MailConfigFile>

/** An account paired with its resolved id. */
export interface ResolvedAccount {
  readonly id: AccountId
  readonly config: AccountConfig
}

/** Expand a leading `~` to the user's home directory. */
export const expandHome = (filePath: string): string =>
  filePath === "~" || filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(1)) : filePath

/** Brand a trusted string as an `AccountId` (values are validated at decode time). */
export const makeAccountId = (id: string): AccountId => id as AccountId

/** Read, JSON-parse, and Schema-decode a file into a typed value in one pass. */
export const readJsonFile = <S extends Schema.Top>(
  filePath: string,
  schema: S,
  label: string,
): Effect.Effect<S["Type"], MailConfigError, FileSystem.FileSystem | S["DecodingServices"]> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const raw = yield* fs.readFileString(filePath).pipe(Effect.mapError(mailConfigError(`Failed to read ${filePath}`)))
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(raw).pipe(
      Effect.mapError(mailConfigError(`Invalid ${label} in ${filePath}`)),
    )
  })

const defaultDir = path.join(os.homedir(), ".mail-control")

export interface AccountsInterface {
  /** The mail-control home directory (holds config.json, secrets.json, creds). */
  readonly dir: string
  /** Every configured account id. */
  readonly ids: ReadonlyArray<AccountId>
  /** Every configured account. */
  readonly all: ReadonlyArray<ResolvedAccount>
  /** Look up an account by id, failing helpfully when it is unknown. */
  readonly get: (id: string) => Effect.Effect<ResolvedAccount, MailConfigError>
}

/**
 * Loads and exposes the account registry defined in `config.json`. This is the
 * single source of truth for which accounts exist; nothing else hardcodes them.
 */
export class Accounts extends Context.Service<Accounts, AccountsInterface>()("mail-control/Accounts") {}

export const layer = Layer.effect(
  Accounts,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* Config.string("MAIL_CONTROL_DIR").pipe(Config.withDefault(defaultDir))
    const configPath = path.join(dir, "config.json")

    const exists = yield* fs.exists(configPath).pipe(Effect.orElseSucceed(() => false))
    if (!exists) {
      return yield* Effect.fail(
        new MailConfigError({
          message: `No config found at ${configPath}. Create it with an "accounts" map (see config.example.json).`,
        }),
      )
    }

    const file = yield* readJsonFile(configPath, MailConfigFile, "config")

    const all: ReadonlyArray<ResolvedAccount> = Object.entries(file.accounts).map(([id, config]) => ({
      id: makeAccountId(id),
      config,
    }))
    const ids = all.map((account) => account.id)
    const byId = new Map(all.map((account) => [account.id as string, account]))

    const get = (id: string): Effect.Effect<ResolvedAccount, MailConfigError> => {
      const found = byId.get(id)
      return found !== undefined
        ? Effect.succeed(found)
        : Effect.fail(
            new MailConfigError({
              message: `Unknown account "${id}". Configured accounts: ${ids.join(", ") || "(none)"}.`,
            }),
          )
    }

    return Accounts.of({ dir, ids, all, get })
  }),
)
