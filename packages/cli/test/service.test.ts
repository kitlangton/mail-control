import type { GmailServiceInterface } from "@mail-control/gmail"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import { makeAccountId } from "../src/config.js"
import type { ICloudServiceInterface } from "../src/icloud.js"
import { makeGmailMailService, makeICloudMailService } from "../src/service.js"

const makeGmail = (overrides: Partial<GmailServiceInterface> = {}): GmailServiceInterface => ({
  authorize: () => Effect.die("not implemented"),
  sendEmail: () => Effect.succeed("message-id"),
  replyToEmail: () => Effect.succeed("message-id"),
  createDraft: () => Effect.succeed({ id: "draft-id", messageId: "message-id" }),
  readMessage: () => Effect.die("not implemented"),
  listMessages: () => Effect.succeed([]),
  getAttachment: () => Effect.die("not implemented"),
  archiveMessage: () => Effect.void,
  trashMessage: () => Effect.void,
  markMessageRead: () => Effect.void,
  unsubscribeFromMessage: () => Effect.succeed({ method: "one-click", destination: "https://example.com" }),
  ...overrides,
})

const makeICloud = (overrides: Partial<ICloudServiceInterface> = {}): ICloudServiceInterface => ({
  listMessages: () => Effect.succeed([]),
  readMessage: () => Effect.die("not implemented"),
  sendEmail: () => Effect.void,
  archiveMessage: () => Effect.void,
  trashMessage: () => Effect.void,
  ...overrides,
})

describe("Gmail mail mutations", () => {
  it("delegates archive, trash, and mark-read operations", async () => {
    const archiveMessage = vi.fn(() => Effect.void)
    const trashMessage = vi.fn(() => Effect.void)
    const markMessageRead = vi.fn(() => Effect.void)
    const mail = makeGmailMailService(
      makeAccountId("gmail"),
      makeGmail({ archiveMessage, trashMessage, markMessageRead }),
    )

    await Effect.runPromise(mail.archiveMessage("message-1"))
    await Effect.runPromise(mail.trashMessage("message-2"))
    await Effect.runPromise(mail.markMessageRead("message-3"))

    expect(archiveMessage).toHaveBeenCalledWith("message-1")
    expect(trashMessage).toHaveBeenCalledWith("message-2")
    expect(markMessageRead).toHaveBeenCalledWith("message-3")
  })

  it("returns the unsubscribe method", async () => {
    const mail = makeGmailMailService(
      makeAccountId("work"),
      makeGmail({
        unsubscribeFromMessage: () => Effect.succeed({ method: "mailto", destination: "unsubscribe@example.com" }),
      }),
    )

    await expect(Effect.runPromise(mail.unsubscribeFromMessage("message-1"))).resolves.toBe("mailto")
  })
})

describe("Gmail mail search", () => {
  it("can search outside the inbox", async () => {
    const listMessages = vi.fn(() => Effect.succeed([]))
    const mail = makeGmailMailService(makeAccountId("gmail"), makeGmail({ listMessages }))

    await Effect.runPromise(mail.listMessages({ query: "receipts", inboxOnly: false }))

    expect(listMessages).toHaveBeenCalledWith({ maxResults: 10, query: "receipts" })
  })
})

describe("iCloud mail mutations", () => {
  it("delegates archive and trash operations", async () => {
    const archiveMessage = vi.fn(() => Effect.void)
    const trashMessage = vi.fn(() => Effect.void)
    const mail = makeICloudMailService(makeICloud({ archiveMessage, trashMessage }))

    await Effect.runPromise(mail.archiveMessage("message-1"))
    await Effect.runPromise(mail.trashMessage("message-2"))

    expect(archiveMessage).toHaveBeenCalledWith("message-1")
    expect(trashMessage).toHaveBeenCalledWith("message-2")
  })
})
