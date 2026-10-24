import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import { mergeAccountListResults, sanitizeAttachmentFilename } from "../src/app.js"
import { MailError, type MailMessageSummary } from "../src/types.js"

const summary = (overrides: Partial<MailMessageSummary>): MailMessageSummary => ({
  account: "gmail",
  id: "message-id",
  subject: "Subject",
  from: "Sender <sender@example.com>",
  ...overrides,
})

describe("mergeAccountListResults", () => {
  it("returns successful account results and warns about the account that failed", async () => {
    const result = await Effect.runPromise(
      mergeAccountListResults(
        [
          {
            account: "gmail",
            exit: Exit.succeed([summary({ id: "gmail-1", date: "Mon, 29 Jun 2026 12:00:00 +0000" })]),
          },
          { account: "icloud", exit: Exit.fail(new MailError({ message: "iCloud config missing" })) },
        ],
        10,
      ),
    )

    expect(result.messages.map((message) => message.id)).toEqual(["gmail-1"])
    expect(result.warnings).toEqual(["icloud: iCloud config missing"])
  })

  it("fails when every account fails", async () => {
    await expect(
      Effect.runPromise(
        mergeAccountListResults(
          [
            { account: "gmail", exit: Exit.fail(new MailError({ message: "gmail failed" })) },
            { account: "icloud", exit: Exit.fail(new MailError({ message: "icloud failed" })) },
          ],
          10,
        ),
      ),
    ).rejects.toBeInstanceOf(MailError)
  })
})

describe("sanitizeAttachmentFilename", () => {
  it("strips directory traversal prefixes and rejects empty or dot names", () => {
    expect(sanitizeAttachmentFilename("../../etc/passwd")).toBe("passwd")
    expect(sanitizeAttachmentFilename("..\\..\\evil.sh")).toBe("evil.sh")
    expect(sanitizeAttachmentFilename("..")).toBe("attachment-1")
    expect(sanitizeAttachmentFilename(".", 2)).toBe("attachment-3")
    expect(sanitizeAttachmentFilename("   ", 1)).toBe("attachment-2")
    expect(sanitizeAttachmentFilename("invoice.pdf")).toBe("invoice.pdf")
  })
})
