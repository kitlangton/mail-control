import { Effect } from "effect"
import { MailError } from "./types.js"

const DAY_MS = 24 * 60 * 60 * 1000

export interface DurationWindow {
  readonly input: string
  readonly milliseconds: number
  readonly sinceDate: Date
  readonly gmailDays: number
  readonly gmailNewerThan: string
  readonly gmailOlderThan: string
}

const UNIT_MS: Record<string, number> = {
  h: 60 * 60 * 1000,
  hour: 60 * 60 * 1000,
  hours: 60 * 60 * 1000,
  d: DAY_MS,
  day: DAY_MS,
  days: DAY_MS,
  w: 7 * DAY_MS,
  week: 7 * DAY_MS,
  weeks: 7 * DAY_MS,
  mo: 30 * DAY_MS,
  month: 30 * DAY_MS,
  months: 30 * DAY_MS,
  y: 365 * DAY_MS,
  year: 365 * DAY_MS,
  years: 365 * DAY_MS,
}

export const parseDurationText = (value: string, now = new Date()): DurationWindow | undefined => {
  const match = value
    .trim()
    .toLowerCase()
    .match(/^(\d+)\s*([a-z]+)$/)
  if (!match) return undefined

  const amount = Number(match[1])
  const unit = match[2]
  const unitMs = unit === undefined ? undefined : UNIT_MS[unit]
  if (!Number.isSafeInteger(amount) || amount <= 0 || unitMs === undefined) return undefined

  const milliseconds = amount * unitMs
  const gmailDays = Math.max(1, Math.ceil(milliseconds / DAY_MS))
  return {
    input: value,
    milliseconds,
    sinceDate: new Date(now.getTime() - milliseconds),
    gmailDays,
    gmailNewerThan: `newer_than:${gmailDays}d`,
    gmailOlderThan: `older_than:${gmailDays}d`,
  }
}

export const parseDuration = (value: string, label: string) =>
  Effect.sync(() => parseDurationText(value)).pipe(
    Effect.flatMap((duration) =>
      duration === undefined
        ? Effect.fail(
            new MailError({
              message: `${label} must be a duration like 24h, 2d, 6w, 12mo, or 1y.`,
            }),
          )
        : Effect.succeed(duration),
    ),
  )

export const combineGmailQuery = (...parts: readonly (string | undefined)[]) =>
  parts
    .map((part) => part?.trim())
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(" ")

export const isOnOrAfter = (date: string | undefined, lowerBound: Date) => {
  if (date === undefined) return true
  const timestamp = Date.parse(date)
  return Number.isNaN(timestamp) ? true : timestamp >= lowerBound.getTime()
}

export const isBefore = (date: string | undefined, upperBound: Date) => {
  if (date === undefined) return true
  const timestamp = Date.parse(date)
  return Number.isNaN(timestamp) ? true : timestamp < upperBound.getTime()
}
