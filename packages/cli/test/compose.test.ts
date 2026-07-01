import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { makeForwardInput } from "../src/compose.js"

describe("makeForwardInput", () => {
  it("preserves HTML source messages as HTML forwards", async () => {
    const input = await Effect.runPromise(
      makeForwardInput(
        {
          action: "forward",
          messageId: "message-1",
          required: false,
          to: ["reimbursements@ramp.com"],
        },
        {
          id: "message-1",
          subject: "Your trip with Uber",
          from: "Uber Receipts <noreply@uber.com>",
          date: "Mon, 15 Jun 2026 05:53:05 +0000 (UTC)",
          body: "<html><body>Total $266.38</body></html>",
          htmlBody: "<html><body>Total $266.38</body></html>",
        },
        [],
      ),
    )

    expect(input.to).toBe("reimbursements@ramp.com")
    expect(input.subject).toBe("Fwd: Your trip with Uber")
    expect(input.htmlBody).toContain("---------- Forwarded message ----------")
    expect(input.htmlBody).toContain("<blockquote><html><body>Total $266.38</body></html></blockquote>")
  })
})
