import { expect, it } from "vitest"
import { accountFailure, MailError } from "../src/errors.js"

it("preserves account-specific sign-in guidance through wrapped provider failures", () => {
  const error = new MailError({
    message: "Failed to list Gmail messages",
    cause: { cause: { response: { status: 400, data: { error: "invalid_grant", private: "not for display" } } } },
  })
  expect(accountFailure("work", error).message).toBe("Sign in again: run mail auth work")
  const offline = new MailError({ message: "Failed to list Gmail messages", cause: { code: "ENOTFOUND" } })
  expect(accountFailure("work", offline)).toBe(offline)
})
