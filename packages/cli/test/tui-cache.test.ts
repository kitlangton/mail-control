import { execFile } from "node:child_process"
import { mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("TuiCache", () => {
  it("restores list and body snapshots after the runtime restarts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mail-control-cache-"))
    temporaryDirectories.push(directory)
    const filename = path.join(directory, "state", "cache.sqlite")
    const script = `
      import { ManagedRuntime } from "effect"
      import { makeAccountId } from "./src/config.ts"
      import { TuiCache } from "./src/tui-cache.ts"
      const filename = process.env.CACHE_PATH
      const summary = { account: makeAccountId("gmail"), id: "message-1", subject: "Cached subject", from: "sender@example.com", unread: true }
      const body = { id: summary.id, subject: summary.subject, from: summary.from, body: "Cached body" }
      const first = ManagedRuntime.make(TuiCache.layerFromPath(filename))
      const firstCache = await first.runPromise(TuiCache)
      await first.runPromise(firstCache.writeList("inbox", [summary]))
      await first.runPromise(firstCache.writeBody("gmail\\u0000message-1", body))
      await first.dispose()
      const second = ManagedRuntime.make(TuiCache.layerFromPath(filename))
      const secondCache = await second.runPromise(TuiCache)
      const list = await second.runPromise(secondCache.readList("inbox"))
      const restoredBody = await second.runPromise(secondCache.readBody("gmail\\u0000message-1"))
      console.log(JSON.stringify({ messages: list?.messages, body: restoredBody }))
      await second.dispose()
    `

    const { stdout } = await execFileAsync("bun", ["-e", script], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, CACHE_PATH: filename },
    })

    expect(JSON.parse(stdout)).toEqual({
      messages: [
        {
          account: "gmail",
          id: "message-1",
          subject: "Cached subject",
          from: "sender@example.com",
          unread: true,
        },
      ],
      body: {
        id: "message-1",
        subject: "Cached subject",
        from: "sender@example.com",
        body: "Cached body",
      },
    })
    expect((await stat(filename)).mode & 0o777).toBe(0o600)
  })
})
