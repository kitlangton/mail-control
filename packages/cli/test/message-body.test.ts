import { describe, expect, it } from "vitest"
import { messageBodyContent } from "../src/message-body.js"

describe("messageBodyContent", () => {
  it("converts HTML structure into renderable Markdown", () => {
    const result = messageBodyContent({
      body: "fallback",
      from: "news@example.com",
      htmlBody:
        '<html><head><style>.hidden{display:none}</style></head><body><h1>Build Week</h1><p>Hello <strong>Kit</strong>.</p><ul><li><a href="https://example.com">Register</a></li></ul></body></html>',
    })

    expect(result.format).toBe("markdown")
    expect(result.content).toContain("# Build Week")
    expect(result.content).toContain("Hello **Kit**.")
    expect(result.content).toContain("Register")
    expect(result.content).not.toContain("https://example.com")
    expect(result.content).not.toContain("display:none")
  })

  it("preserves plain text while removing invisible email formatting characters", () => {
    expect(messageBodyContent({ body: "soft\u00adhyphen and zero\u200bwidth", from: "person@example.com" })).toEqual({
      format: "text",
      content: "softhyphen and zerowidth",
    })
  })

  it("prefers GitHub's clean plain-text alternative", () => {
    expect(
      messageBodyContent({
        body: "> +\n+case class Row(value: Option[String])",
        from: "GitHub <notifications@github.com>",
        htmlBody: "<p><strong>commented</strong></p><pre>+case class Row(value: Option[String])</pre>",
      }),
    ).toEqual({
      format: "text",
      content: "> +\n+case class Row(value: Option[String])",
    })
  })

  it("collapses invisible HTML spacer blocks for terminal display", () => {
    const result = messageBodyContent({
      body: "fallback",
      from: "mailer@example.com",
      htmlBody: "<p>Hello</p><div>&nbsp;</div><div> ͏  ͏  ͏</div><div>&nbsp;</div><p>World</p>",
    })

    expect(result).toEqual({ format: "markdown", content: "Hello\n\nWorld" })
  })

  it("joins layout-driven breaks inside a sentence", () => {
    const result = messageBodyContent({
      body: "fallback",
      from: "mailer@example.com",
      htmlBody:
        "<p>We are working to restore full</p><p>functionality as quickly as possible.</p><p>Next update soon.</p>",
    })

    expect(result).toEqual({
      format: "markdown",
      content: "We are working to restore full functionality as quickly as possible.\n\nNext update soon.",
    })
  })

  it("drops brand images but keeps descriptive alt text", () => {
    const result = messageBodyContent({
      body: "fallback",
      from: "mailer@example.com",
      htmlBody:
        '<img src="brand.png" alt="AppFolio"><p>Hello</p><img src="chart.png" alt="Chart showing applications by month">',
    })

    expect(result).toEqual({
      format: "markdown",
      content: "Hello\n\n_Image: Chart showing applications by month_",
    })
  })
})
