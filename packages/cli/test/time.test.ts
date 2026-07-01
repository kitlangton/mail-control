import { describe, expect, it } from "vitest"
import { parseDurationText } from "../src/time.js"

describe("parseDurationText", () => {
  it("parses human durations and exposes Gmail day windows", () => {
    const now = new Date("2026-06-29T12:00:00.000Z")
    const duration = parseDurationText("48h", now)

    expect(duration?.gmailNewerThan).toBe("newer_than:2d")
    expect(duration?.gmailOlderThan).toBe("older_than:2d")
    expect(duration?.sinceDate.toISOString()).toBe("2026-06-27T12:00:00.000Z")
  })

  it("rejects ambiguous month/minute shorthand", () => {
    expect(parseDurationText("1m")).toBeUndefined()
    expect(parseDurationText("1mo")?.gmailNewerThan).toBe("newer_than:30d")
  })
})
