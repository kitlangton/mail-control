import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import { mergeAccountListResults } from "../src/app.js"
import { MailError, type MailMessageSummary } from "../src/types.js"

const summary = (overrides: Partial<MailMessageSummary>): MailMessageSummary => ({
  account: "gmail",
  id: "message-id",
  subject: "Subject",
  from: "Sender <sender@example.com>",
  ...overrides,
})

describe("mergeAccountListResults", () => {
  it("returns successful account results when another account fails", async () => {
    const result = await Effect.runPromise(
      mergeAccountListResults(
        [
          Exit.succeed([summary({ id: "gmail-1", date: "Mon, 29 Jun 2026 12:00:00 +0000" })]),
          Exit.fail(new MailError({ message: "iCloud config missing" })),
        ],
        10,
      ),
    )

    expect(result.map((message) => message.id)).toEqual(["gmail-1"])
  })

  it("fails when every account fails", async () => {
    await expect(
      Effect.runPromise(
        mergeAccountListResults(
          [
            Exit.fail(new MailError({ message: "gmail failed" })),
            Exit.fail(new MailError({ message: "icloud failed" })),
          ],
          10,
        ),
      ),
    ).rejects.toBeInstanceOf(MailError)
  })
})
