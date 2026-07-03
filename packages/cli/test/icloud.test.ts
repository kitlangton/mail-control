import { describe, expect, it } from "vitest"
import { parseRawHeaders } from "../src/icloud.js"

describe("parseRawHeaders", () => {
  it("parses simple header lines", () => {
    const headers = parseRawHeaders(
      "List-Unsubscribe: <https://example.com/unsubscribe>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n",
    )

    expect(headers.get("list-unsubscribe")).toBe("<https://example.com/unsubscribe>")
    expect(headers.get("list-unsubscribe-post")).toBe("List-Unsubscribe=One-Click")
  })

  it("unfolds continuation lines", () => {
    const headers = parseRawHeaders(
      "List-Unsubscribe: <mailto:unsubscribe@example.com>,\r\n <https://example.com/unsubscribe>\r\n",
    )

    expect(headers.get("list-unsubscribe")).toBe("<mailto:unsubscribe@example.com>, <https://example.com/unsubscribe>")
  })

  it("lowercases header names and ignores lines without a colon", () => {
    const headers = parseRawHeaders("Subject: Hi\r\nnot-a-header-line\r\nFROM: a@b.com\r\n")

    expect(headers.get("subject")).toBe("Hi")
    expect(headers.get("from")).toBe("a@b.com")
    expect(headers.size).toBe(2)
  })
})
