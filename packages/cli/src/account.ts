import path from "node:path"
import { type GmailInstanceConfig, makeGmailService } from "@mail-control/gmail"
import { Effect } from "effect"
import {
  type AccountId,
  Accounts,
  type AccountType,
  expandHome,
  type GmailAccountConfig,
  type ResolvedAccount,
} from "./config.js"
import { MailError, mailError, toMailError } from "./errors.js"
import { makeICloudService } from "./icloud.js"
import { Secrets } from "./secrets.js"
import { type MailService, makeGmailMailService, makeICloudMailService } from "./service.js"

/** Context required to acquire a provider for an account. */
export type AccountEnv = Accounts | Secrets

export type MailCapability =
  | "read"
  | "send"
  | "reply"
  | "forward"
  | "downloadAttachments"
  | "archive"
  | "trash"
  | "markRead"
  | "unsubscribe"

const GMAIL_CAPABILITIES: ReadonlySet<MailCapability> = new Set([
  "read",
  "send",
  "reply",
  "forward",
  "downloadAttachments",
  "archive",
  "trash",
  "markRead",
  "unsubscribe",
])

/** Capabilities are a property of the account *type*, not the account name. */
const TYPE_CAPABILITIES: Record<AccountType, ReadonlySet<MailCapability>> = {
  gmail: GMAIL_CAPABILITIES,
  icloud: new Set(["read", "send", "archive", "trash", "unsubscribe"]),
}

/** Resolve an account's Gmail credential + token paths (config overrides, else derived from id). */
export const gmailAccountPaths = (id: AccountId, config: GmailAccountConfig, dir: string): GmailInstanceConfig => ({
  credentialsPath: expandHome(config.credentialsPath ?? path.join(dir, `${id}-credentials.json`)),
  tokenPath: expandHome(config.tokenPath ?? path.join(dir, `${id}-token.json`)),
})

const acquireMailService = (account: ResolvedAccount): Effect.Effect<MailService["Service"], MailError, AccountEnv> =>
  Effect.gen(function* () {
    const config = account.config
    if (config.type === "gmail") {
      const accounts = yield* Accounts
      const gmail = yield* makeGmailService(gmailAccountPaths(account.id, config, accounts.dir)).pipe(
        Effect.mapError(mailError(`Could not initialize account "${account.id}" — run: mail auth ${account.id}`)),
      )
      return makeGmailMailService(account.id, gmail)
    }

    const secrets = yield* Secrets
    const password = yield* secrets.appPassword(account).pipe(Effect.mapError(toMailError))
    return makeICloudMailService(makeICloudService(account.id, config, password))
  })

export const withAccount = <A, R>(
  account: ResolvedAccount,
  run: (mail: MailService["Service"]) => Effect.Effect<A, MailError, R>,
): Effect.Effect<A, MailError, R | AccountEnv> =>
  Effect.gen(function* () {
    const mail = yield* acquireMailService(account)
    return yield* run(mail)
  })

/**
 * Resolves an account selection to a configured account, verifying the account
 * type supports the requested capability. `"all"` is rejected for single-message
 * actions.
 */
export const requireAccount = (
  selection: string,
  capability: MailCapability,
  action: string,
): Effect.Effect<ResolvedAccount, MailError, Accounts> =>
  Effect.gen(function* () {
    if (selection === "all") {
      return yield* Effect.fail(new MailError({ message: `${action} requires a specific --account, not "all".` }))
    }

    const accounts = yield* Accounts
    const account = yield* accounts.get(selection).pipe(Effect.mapError(toMailError))

    if (!TYPE_CAPABILITIES[account.config.type].has(capability)) {
      return yield* Effect.fail(
        new MailError({ message: `${action} is not supported for ${account.config.type} account "${account.id}".` }),
      )
    }

    return account
  })
