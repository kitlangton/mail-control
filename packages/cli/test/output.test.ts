import { spawn } from "node:child_process"
import path from "node:path"
import { describe, expect, it } from "vitest"

describe("piped output", () => {
  it.each(["json", "text"])("drains large %s bodies before exiting", async (format) => {
    const script = `
      import { NodeRuntime } from "@effect/platform-node"
      import { printJson, printMessage } from "./src/renderer.ts"
      const message = { id: "synthetic", subject: "Test", from: "sender@example.test", body: "x".repeat(1048576) }
      NodeRuntime.runMain(${format === "json" ? "printJson(message)" : "printMessage(message)"})
    `
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn("bun", ["-e", script], { cwd: path.resolve(import.meta.dirname, "..") })
      const chunks: Buffer[] = []
      child.stdout.pause()
      const timer = setTimeout(() => child.stdout.resume(), 250)
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
      child.on("error", reject)
      child.on("close", (code) => {
        clearTimeout(timer)
        if (code !== 0) reject(new Error(`child exited ${code}`))
        else resolve(Buffer.concat(chunks).toString())
      })
    })
    if (format === "json") expect(JSON.parse(output).body.length).toBe(1048576)
    else expect(output.endsWith(`${"x".repeat(1048576)}\n`)).toBe(true)
  })
})
