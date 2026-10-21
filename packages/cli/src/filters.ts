import {
  GMAIL_SETTINGS_SCOPE,
  type GmailAuthError,
  type GmailConfigError,
  type GmailError,
  type GmailFilter,
  type GmailFilterInput,
  type GmailLabel,
  type GmailScopeError,
  type GmailServiceInterface,
} from "@mail-control/gmail"
import { Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { requireAccount, withGmail } from "./account.js"
import type { Accounts } from "./config.js"
import { MailError } from "./errors.js"
import { Console } from "./output.js"
import { printJson } from "./renderer.js"

export interface FilterOptions {
  readonly from?: string
  readonly to?: string
  readonly subject?: string
  readonly query?: string
  readonly hasWords?: string
  readonly negatedQuery?: string
  readonly skipInbox: boolean
  readonly markRead: boolean
  readonly label?: string
  readonly trash: boolean
  readonly spam: boolean
  readonly neverSpam: boolean
}

/** A `--label` resolved against the account's labels. `id` is absent when it doesn't exist yet. */
export interface ResolvedLabel {
  readonly name: string
  readonly id?: string
  readonly created: boolean
}

type GmailFailure = GmailError | GmailConfigError | GmailAuthError | GmailScopeError

export const SPAM_UNSUPPORTED_MESSAGE =
  "Gmail filters can't send mail to Spam: the API rejects SPAM in addLabelIds. " +
  "Use --skip-inbox --mark-read (optionally with --label <name>), or --trash, instead."

export const missingFilterScopeMessage = (account: string) =>
  [
    `Account "${account}" hasn't granted Gmail filter access (${GMAIL_SETTINGS_SCOPE}).`,
    `Re-authorize it in a browser with:  mail auth ${account}`,
    `That requests the full scope set, so send/modify keep working.`,
  ].join("\n")

const causeDetail = (cause: unknown): string =>
  cause instanceof Error && cause.message.length > 0 ? `: ${cause.message}` : ""

/** Map Gmail failures to `MailError`, turning a missing settings scope into a re-auth instruction. */
export const toFilterError =
  (account: string) =>
  (error: GmailFailure): MailError =>
    error._tag === "GmailScopeError"
      ? new MailError({ message: missingFilterScopeMessage(account), cause: error })
      : new MailError({ message: `${error.message}${causeDetail(error.cause)}`, cause: error })

const nonEmpty = (value: string | undefined): value is string => value !== undefined && value.trim().length > 0

/** Build the `users.settings.filters.create` body from CLI options. */
export const buildFilterRequest = (
  options: FilterOptions,
  labelId?: string,
): Effect.Effect<GmailFilterInput, MailError> =>
  Effect.gen(function* () {
    if (options.spam) return yield* new MailError({ message: SPAM_UNSUPPORTED_MESSAGE })

    const query = [options.query, options.hasWords].filter(nonEmpty).join(" ")
    const criteria = {
      ...(nonEmpty(options.from) ? { from: options.from } : {}),
      ...(nonEmpty(options.to) ? { to: options.to } : {}),
      ...(nonEmpty(options.subject) ? { subject: options.subject } : {}),
      ...(query.length > 0 ? { query } : {}),
      ...(nonEmpty(options.negatedQuery) ? { negatedQuery: options.negatedQuery } : {}),
    }
    if (Object.keys(criteria).length === 0) {
      return yield* new MailError({
        message:
          "A filter needs at least one criterion: --from, --to, --subject, --query, --has-words, --negated-query.",
      })
    }

    if (options.label !== undefined && labelId === undefined) {
      return yield* new MailError({ message: `Label "${options.label}" was not resolved.` })
    }

    const addLabelIds = [...(labelId !== undefined ? [labelId] : []), ...(options.trash ? ["TRASH"] : [])]
    const removeLabelIds = [
      ...(options.skipInbox ? ["INBOX"] : []),
      ...(options.markRead ? ["UNREAD"] : []),
      ...(options.neverSpam ? ["SPAM"] : []),
    ]
    if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
      return yield* new MailError({
        message: "A filter needs at least one action: --skip-inbox, --mark-read, --label, --trash, --never-spam.",
      })
    }

    return {
      criteria,
      action: {
        ...(addLabelIds.length > 0 ? { addLabelIds } : {}),
        ...(removeLabelIds.length > 0 ? { removeLabelIds } : {}),
      },
    }
  })

const findLabel = (labels: readonly GmailLabel[], name: string): GmailLabel | undefined =>
  labels.find((label) => label.name === name) ??
  labels.find((label) => label.id === name || label.name.toLowerCase() === name.toLowerCase())

/**
 * Resolve `--label` to an existing label id (by name, case-insensitively, or by
 * system id). With `create`, missing labels are created, parents first, so
 * `Stripe/test-mode` nests under `Stripe` like it does in the Gmail UI.
 */
export const resolveLabel = (
  gmail: Pick<GmailServiceInterface, "listLabels" | "createLabel">,
  name: string,
  options: { readonly create: boolean },
): Effect.Effect<ResolvedLabel, GmailError | GmailConfigError | GmailAuthError | MailError> =>
  Effect.gen(function* () {
    const trimmed = name.trim()
    if (trimmed.length === 0) return yield* new MailError({ message: "--label cannot be empty." })

    const labels = yield* gmail.listLabels()
    const existing = findLabel(labels, trimmed)
    if (existing) return { name: existing.name, id: existing.id, created: false }
    if (!options.create) return { name: trimmed, created: false }

    const segments = trimmed.split("/")
    for (let index = 1; index < segments.length; index++) {
      const parent = segments.slice(0, index).join("/")
      if (!findLabel(labels, parent)) labels.push(yield* gmail.createLabel(parent))
    }
    const created = yield* gmail.createLabel(trimmed)
    return { name: created.name, id: created.id, created: true }
  })

const labelNames = (ids: readonly string[] | undefined, labels: readonly GmailLabel[]): string[] =>
  (ids ?? []).map((id) => labels.find((label) => label.id === id)?.name ?? id)

export const describeFilter = (filter: GmailFilterInput, labels: readonly GmailLabel[]): string => {
  const { criteria, action } = filter
  const matches = [
    criteria.from && `from:${criteria.from}`,
    criteria.to && `to:${criteria.to}`,
    criteria.subject && `subject:${JSON.stringify(criteria.subject)}`,
    criteria.query && `has:${JSON.stringify(criteria.query)}`,
    criteria.negatedQuery && `not:${JSON.stringify(criteria.negatedQuery)}`,
  ].filter(Boolean)
  const removed = action.removeLabelIds ?? []
  const effects = [
    removed.includes("INBOX") && "skip inbox",
    removed.includes("UNREAD") && "mark read",
    removed.includes("SPAM") && "never spam",
    ...labelNames(action.addLabelIds, labels).map((name) => (name === "TRASH" ? "trash" : `label ${name}`)),
    ...labelNames(
      removed.filter((id) => !["INBOX", "UNREAD", "SPAM"].includes(id)),
      labels,
    ).map((name) => `remove label ${name}`),
  ].filter(Boolean)
  return `${matches.join(" ")} → ${effects.join(", ")}`
}

const requireFilterAccount = (account: string) => requireAccount(account, "filters", "Managing filters")

export const listFilters = (
  account: string,
): Effect.Effect<{ filters: GmailFilter[]; labels: GmailLabel[] }, MailError, Accounts> =>
  Effect.gen(function* () {
    const resolved = yield* requireFilterAccount(account)
    return yield* withGmail(resolved, (gmail) =>
      Effect.all({ filters: gmail.listFilters(), labels: gmail.listLabels() }).pipe(
        Effect.mapError(toFilterError(resolved.id)),
      ),
    )
  })

export interface CreateFilterResult {
  readonly account: string
  readonly dryRun: boolean
  readonly request: GmailFilterInput
  readonly label?: ResolvedLabel
  readonly filter?: GmailFilter
}

export const createFilter = (
  account: string,
  options: FilterOptions,
  dryRun: boolean,
): Effect.Effect<CreateFilterResult, MailError, Accounts> =>
  Effect.gen(function* () {
    const resolved = yield* requireFilterAccount(account)
    // Validate flags before touching the network.
    yield* buildFilterRequest(options, options.label)

    if (dryRun && options.label === undefined) {
      return { account: resolved.id, dryRun, request: yield* buildFilterRequest(options) }
    }

    return yield* withGmail(resolved, (gmail) =>
      Effect.gen(function* () {
        const label =
          options.label === undefined ? undefined : yield* resolveLabel(gmail, options.label, { create: !dryRun })
        const labelId = label === undefined ? undefined : (label.id ?? `<new label: ${label.name}>`)
        const request = yield* buildFilterRequest(options, labelId)
        const base = { account: resolved.id, dryRun, request, ...(label !== undefined ? { label } : {}) }
        if (dryRun) return base
        const filter = yield* gmail.createFilter(request)
        return { ...base, filter }
      }).pipe(Effect.mapError((error) => (error instanceof MailError ? error : toFilterError(resolved.id)(error)))),
    )
  })

export const deleteFilter = (account: string, id: string): Effect.Effect<void, MailError, Accounts> =>
  Effect.gen(function* () {
    const resolved = yield* requireFilterAccount(account)
    return yield* withGmail(resolved, (gmail) =>
      gmail.deleteFilter(id).pipe(Effect.mapError(toFilterError(resolved.id))),
    )
  })

const accountOption = Flag.String("account").pipe(
  Flag.withAlias("a"),
  Flag.withDescription("Gmail account id from your config.json"),
)
const jsonOption = Flag.Boolean("json").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print machine-readable JSON"),
)
const optionalText = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.optional, Flag.withDescription(description))
const toggle = (name: string, description: string) =>
  Flag.Boolean(name).pipe(Flag.withDefault(false), Flag.withDescription(description))

const listCommand = Command.make("list", { account: accountOption, json: jsonOption }, ({ account, json }) =>
  Effect.gen(function* () {
    const { filters, labels } = yield* listFilters(account)
    if (json) {
      yield* printJson(
        filters.map((filter) => ({
          ...filter,
          labels: {
            add: labelNames(filter.action.addLabelIds, labels),
            remove: labelNames(filter.action.removeLabelIds, labels),
          },
        })),
      )
      return
    }
    if (filters.length === 0) {
      yield* Console.log("No filters found.")
      return
    }
    for (const filter of filters) {
      yield* Console.log(`${filter.id}  ${describeFilter(filter, labels)}`)
    }
  }),
).pipe(Command.withDescription("List the account's Gmail filters"))

const createCommand = Command.make(
  "create",
  {
    account: accountOption,
    from: optionalText("from", "Match the sender"),
    to: optionalText("to", "Match the recipient"),
    subject: optionalText("subject", "Match words in the subject"),
    query: optionalText("query", "Match a Gmail search query"),
    hasWords: optionalText("has-words", "Match Gmail 'Has the words' terms (combined with --query)"),
    negatedQuery: optionalText("negated-query", "Exclude messages matching this Gmail query ('Doesn't have')"),
    skipInbox: toggle("skip-inbox", "Skip the inbox (archive)"),
    markRead: toggle("mark-read", "Mark as read"),
    label: optionalText("label", "Apply this label, creating it if missing (e.g. Stripe/test-mode)"),
    trash: toggle("trash", "Delete it (move to Trash)"),
    spam: toggle("spam", "Send to Spam (rejected: Gmail filters can't add SPAM)"),
    neverSpam: toggle("never-spam", "Never send it to Spam"),
    dryRun: toggle("dry-run", "Print the filter request body without creating anything"),
    json: jsonOption,
  },
  ({ account, dryRun, json, ...flags }) =>
    Effect.gen(function* () {
      const options: FilterOptions = {
        skipInbox: flags.skipInbox,
        markRead: flags.markRead,
        trash: flags.trash,
        spam: flags.spam,
        neverSpam: flags.neverSpam,
        ...Option.match(flags.from, { onNone: () => ({}), onSome: (from) => ({ from }) }),
        ...Option.match(flags.to, { onNone: () => ({}), onSome: (to) => ({ to }) }),
        ...Option.match(flags.subject, { onNone: () => ({}), onSome: (subject) => ({ subject }) }),
        ...Option.match(flags.query, { onNone: () => ({}), onSome: (query) => ({ query }) }),
        ...Option.match(flags.hasWords, { onNone: () => ({}), onSome: (hasWords) => ({ hasWords }) }),
        ...Option.match(flags.negatedQuery, { onNone: () => ({}), onSome: (negatedQuery) => ({ negatedQuery }) }),
        ...Option.match(flags.label, { onNone: () => ({}), onSome: (label) => ({ label }) }),
      }
      const result = yield* createFilter(account, options, dryRun)
      if (json) {
        yield* printJson(result)
        return
      }
      if (result.dryRun) {
        yield* Console.log(`Dry run: would create this filter on "${result.account}" (POST users/me/settings/filters):`)
        yield* printJson(result.request)
        return
      }
      if (result.label?.created) yield* Console.log(`Created label ${result.label.name} (${result.label.id})`)
      yield* Console.log(`✅ Created filter ${result.filter?.id ?? "(unknown id)"}`)
    }),
).pipe(Command.withDescription("Create a Gmail filter"))

const deleteCommand = Command.make(
  "delete",
  {
    account: accountOption,
    id: Argument.String("id").pipe(Argument.withDescription("Filter id (from `mail filters list`)")),
    json: jsonOption,
  },
  ({ account, id, json }) =>
    Effect.gen(function* () {
      yield* deleteFilter(account, id)
      yield* json ? printJson({ account, id, deleted: true }) : Console.log(`Deleted filter ${id}`)
    }),
).pipe(Command.withDescription("Delete a Gmail filter"))

export const filtersCommand = Command.make("filters", {}).pipe(
  Command.withDescription(`Manage Gmail filters (needs the ${GMAIL_SETTINGS_SCOPE} scope; re-run mail auth <id> once)`),
  Command.withSubcommands([listCommand, createCommand, deleteCommand]),
)
