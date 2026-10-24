import { expect, it } from "vitest"
import { accountFailure, isHostFailure, MailError } from "../src/errors.js"

it("preserves account-specific sign-in guidance through wrapped provider failures", () => {
  const error = new MailError({
    message: "Failed to list Gmail messages",
    cause: { cause: { response: { status: 400, data: { error: "invalid_grant", private: "not for display" } } } },
  })
  expect(accountFailure("work", error).message).toBe("Sign in again: run mail auth work")
  const imapAuth = new MailError({
    message: "Failed to connect to iCloud IMAP",
    cause: { authenticationFailed: true },
  })
  expect(accountFailure("icloud", imapAuth).message).toBe("Sign in again: run mail auth icloud")
  const offline = new MailError({ message: "Failed to list Gmail messages", cause: { code: "ENOTFOUND" } })
  expect(accountFailure("work", offline)).toBe(offline)
  expect(isHostFailure(offline)).toBe(true)
  expect(isHostFailure(error)).toBe(false)
})
