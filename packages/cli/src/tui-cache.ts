import { chmod, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { Context, Effect, Layer, Schema } from "effect"
import * as Migrator from "effect/unstable/sql/Migrator"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { makeAccountId } from "./config.js"
import type { MailMessageBody, MailMessageSummary } from "./types.js"

const SummarySchema = Schema.Struct({
  account: Schema.String,
  id: Schema.String,
  subject: Schema.String,
  from: Schema.String,
  date: Schema.optionalKey(Schema.String),
  snippet: Schema.optionalKey(Schema.String),
  unread: Schema.optionalKey(Schema.Boolean),
})
const AttachmentSchema = Schema.Struct({
  id: Schema.String,
  filename: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number,
})
const BodySchema = Schema.Struct({
  id: Schema.String,
  subject: Schema.String,
  from: Schema.String,
  date: Schema.optionalKey(Schema.String),
  body: Schema.String,
  htmlBody: Schema.optionalKey(Schema.String),
  unread: Schema.optionalKey(Schema.Boolean),
  attachments: Schema.optionalKey(Schema.Array(AttachmentSchema)),
})
const SummariesSchema = Schema.Array(SummarySchema)

interface JsonRow {
  readonly data_json: string
}

interface SnapshotRow extends JsonRow {
  readonly fetched_at: string
}

export interface ListSnapshot {
  readonly messages: readonly MailMessageSummary[]
  readonly fetchedAt: number
}

const parseJson = (value: string) => Effect.try(() => JSON.parse(value) as unknown)

const decodeSummaries = (value: string) =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(SummariesSchema)(yield* parseJson(value))
    return decoded.map((message): MailMessageSummary => ({ ...message, account: makeAccountId(message.account) }))
  })

const decodeBody = (value: string) =>
  Effect.gen(function* () {
    const parsed = yield* parseJson(value)
    const decoded = yield* Schema.decodeUnknownEffect(BodySchema)(parsed)
    const { attachments, ...message } = decoded
    return attachments ? { ...message, attachments: attachments.map((attachment) => ({ ...attachment })) } : message
  })

const migrations = {
  "001_tui_snapshots": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE IF NOT EXISTS list_snapshots (
      view_key TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    )`
    yield* sql`CREATE TABLE IF NOT EXISTS body_snapshots (
      message_key TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    )`
    yield* sql`CREATE INDEX IF NOT EXISTS list_snapshots_fetched_at_idx ON list_snapshots (fetched_at)`
    yield* sql`CREATE INDEX IF NOT EXISTS body_snapshots_fetched_at_idx ON body_snapshots (fetched_at)`
  }),
} satisfies Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>

const live = (sql: SqlClient.SqlClient) => {
  const readList = (key: string) =>
    Effect.gen(function* () {
      const rows =
        yield* sql<SnapshotRow>`SELECT data_json, fetched_at FROM list_snapshots WHERE view_key = ${key} LIMIT 1`
      const row = rows[0]
      if (!row) return null
      const messages = yield* decodeSummaries(row.data_json)
      const fetchedAt = Date.parse(row.fetched_at)
      return Number.isFinite(fetchedAt) ? { messages, fetchedAt } : null
    }).pipe(Effect.catch(() => Effect.succeed(null)))

  const writeList = (key: string, messages: readonly MailMessageSummary[], fetchedAt = Date.now()) =>
    sql`INSERT INTO list_snapshots ${sql.insert({ view_key: key, data_json: JSON.stringify(messages), fetched_at: new Date(fetchedAt).toISOString() })}
      ON CONFLICT(view_key) DO UPDATE SET data_json = excluded.data_json, fetched_at = excluded.fetched_at`.pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.void),
    )

  const readBody = (key: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<JsonRow>`SELECT data_json FROM body_snapshots WHERE message_key = ${key} LIMIT 1`
      const row = rows[0]
      if (!row) return null
      return yield* decodeBody(row.data_json)
    }).pipe(Effect.catch(() => Effect.succeed(null)))

  const writeBody = (key: string, message: MailMessageBody) =>
    sql`INSERT INTO body_snapshots ${sql.insert({ message_key: key, data_json: JSON.stringify(message), fetched_at: new Date().toISOString() })}
      ON CONFLICT(message_key) DO UPDATE SET data_json = excluded.data_json, fetched_at = excluded.fetched_at`.pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.void),
    )

  const clearLists = () =>
    sql`DELETE FROM list_snapshots`.pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.void),
    )
  const prune = () => {
    const listCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const bodyCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    return Effect.all([
      sql`DELETE FROM list_snapshots WHERE fetched_at < ${listCutoff}`,
      sql`DELETE FROM body_snapshots WHERE fetched_at < ${bodyCutoff}`,
    ]).pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.void),
    )
  }

  return TuiCache.of({ readList, writeList, readBody, writeBody, clearLists, prune })
}

export class TuiCache extends Context.Service<
  TuiCache,
  {
    readonly readList: (key: string) => Effect.Effect<ListSnapshot | null>
    readonly writeList: (
      key: string,
      messages: readonly MailMessageSummary[],
      fetchedAt?: number,
    ) => Effect.Effect<void>
    readonly readBody: (key: string) => Effect.Effect<MailMessageBody | null>
    readonly writeBody: (key: string, message: MailMessageBody) => Effect.Effect<void>
    readonly clearLists: () => Effect.Effect<void>
    readonly prune: () => Effect.Effect<void>
  }
>()("mail-control/TuiCache") {
  static readonly disabledLayer = Layer.succeed(
    TuiCache,
    TuiCache.of({
      readList: () => Effect.succeed(null),
      writeList: () => Effect.void,
      readBody: () => Effect.succeed(null),
      writeBody: () => Effect.void,
      clearLists: () => Effect.void,
      prune: () => Effect.void,
    }),
  )

  static readonly layerSqlite = Layer.effect(TuiCache, Effect.map(SqlClient.SqlClient, live))

  static readonly layerFromPath = (filename: string): Layer.Layer<TuiCache> => {
    const sqlLayer = SqliteClient.layer({ filename, disableWAL: true })
    const setup = Layer.effectDiscard(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`PRAGMA synchronous = NORMAL`
        yield* sql`PRAGMA busy_timeout = 5000`
        yield* sql`PRAGMA secure_delete = ON`
        yield* SqliteMigrator.run({ loader: Migrator.fromRecord(migrations), table: "mail_control_cache_migrations" })
        yield* Effect.tryPromise(() => chmod(filename, 0o600)).pipe(Effect.ignore)
      }),
    )
    const liveLayer = Layer.mergeAll(setup, TuiCache.layerSqlite).pipe(Layer.provide(sqlLayer))
    return Layer.unwrap(
      Effect.tryPromise(() => mkdir(dirname(filename), { recursive: true, mode: 0o700 })).pipe(
        Effect.as(liveLayer),
        Effect.catch(() => Effect.succeed(TuiCache.disabledLayer)),
      ),
    ).pipe(Layer.catchCause(() => TuiCache.disabledLayer))
  }
}
