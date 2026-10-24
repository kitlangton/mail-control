import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  buildSearchCriteria,
  findUnsubscribeUrl,
  formatICloudMessageId,
  parseICloudMessageId,
  parseRawHeaders,
} from "../src/icloud.js"
import { MailError } from "../src/types.js"

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

describe("findUnsubscribeUrl", () => {
  it("decodes a quoted-printable unsubscribe link", () => {
    expect(
      findUnsubscribeUrl(
        'Content-Transfer-Encoding: quoted-printable\r\n\r\n<a href=3D"https://example.com/unsubscribe?email=3Dkit%40example.com&token=3Dabc=\r\n123">Unsubscribe</a>',
      ),
    ).toBe("https://example.com/unsubscribe?email=kit%40example.com&token=abc123")
  })

  it("prefers an explicit unsubscribe URL over a tracking URL", () => {
    expect(
      findUnsubscribeUrl(
        "Unsubscribe: https://tracking.example.com/click?token=abc https://example.com/unsubscribe?token=abc",
      ),
    ).toBe("https://example.com/unsubscribe?token=abc")
  })
})

describe("buildSearchCriteria", () => {
  const now = new Date("2026-10-24T12:00:00.000Z")

  it("maps since Date and unread status without polluting subject/from", () => {
    const since = new Date("2026-10-23T12:00:00.000Z")
    expect(buildSearchCriteria({ status: "unread", since }, now)).toEqual({
      seen: false,
      since,
    })
  })

  it("translates Gmail-style from:, subject:, is:unread, and newer_than: operators to IMAP criteria", () => {
    expect(
      buildSearchCriteria({ query: 'from:amazon subject:"your order" is:unread newer_than:2d invoice' }, now),
    ).toEqual({
      from: "amazon",
      subject: "your order",
      seen: false,
      since: new Date("2026-10-22T12:00:00.000Z"),
      or: [{ subject: "invoice" }, { from: "invoice" }],
    })
  })

  it("combines repeated from: operators and treats m as months in newer_than:/older_than:", () => {
    expect(buildSearchCriteria({ query: "from:alice@example.com OR from:bob@example.com newer_than:3m" }, now)).toEqual(
      {
        since: new Date("2026-07-26T12:00:00.000Z"),
        or: [{ from: "alice@example.com" }, { from: "bob@example.com" }],
      },
    )
  })

  it("throws MailError on unknown operators or invalid operator values", () => {
    expect(() => buildSearchCriteria({ query: "label:work" }, now)).toThrow(MailError)
    expect(() => buildSearchCriteria({ query: "has:attachment" }, now)).toThrow(MailError)
    expect(() => buildSearchCriteria({ query: "is:starred" }, now)).toThrow(MailError)
    expect(() => buildSearchCriteria({ query: "newer_than:xyz" }, now)).toThrow(MailError)
  })
})

describe("iCloud message IDs", () => {
  it("formats INBOX as bare UID and non-INBOX with mailbox prefix", () => {
    expect(formatICloudMessageId("INBOX", 1370)).toBe("1370")
    expect(formatICloudMessageId("Archive", 1370)).toBe("Archive:1370")
    expect(formatICloudMessageId("Sent Messages", 42)).toBe("Sent Messages:42")
  })

  it("parses both bare UIDs and mailbox-prefixed IDs", async () => {
    await expect(Effect.runPromise(parseICloudMessageId("1370"))).resolves.toEqual({
      mailbox: "INBOX",
      uid: 1370,
    })
    await expect(Effect.runPromise(parseICloudMessageId("Archive:1370"))).resolves.toEqual({
      mailbox: "Archive",
      uid: 1370,
    })
    await expect(Effect.runPromise(parseICloudMessageId("Sent Messages:42"))).resolves.toEqual({
      mailbox: "Sent Messages",
      uid: 42,
    })
    await expect(Effect.runPromise(parseICloudMessageId("Archive:not-a-uid"))).rejects.toBeInstanceOf(MailError)
  })
})
