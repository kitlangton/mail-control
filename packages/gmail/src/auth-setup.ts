#!/usr/bin/env bun
import fs from "node:fs/promises"
/**
 * One-time OAuth setup script for Gmail API.
 * Opens browser, receives callback on localhost, saves token, exits.
 */
import { createServer } from "node:http"
import path from "node:path"
import { google } from "googleapis"
import { defaultGmailCredentialsPath, defaultGmailTokenPath } from "./paths.js"

const CREDENTIALS_PATH = process.env.GOOGLE_CLIENT_SECRET_PATH ?? defaultGmailCredentialsPath()
const TOKEN_PATH = process.env.GOOGLE_TOKEN_PATH ?? defaultGmailTokenPath(CREDENTIALS_PATH)
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
]
const PORT = 8374

async function main() {
  console.log("📧 Gmail OAuth Setup\n")
  console.log(`Credentials: ${CREDENTIALS_PATH}`)
  console.log(`Token: ${TOKEN_PATH}\n`)

  // Load credentials
  const credentialsRaw = await fs.readFile(CREDENTIALS_PATH, "utf8")
  const credentials = JSON.parse(credentialsRaw)
  const { client_id, client_secret } = credentials.installed ?? credentials.web

  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, `http://localhost:${PORT}`)

  // Generate auth URL
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  })

  // Start local server to receive callback
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`)
    const code = url.searchParams.get("code")

    if (code) {
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end("<h1>✅ Authorization successful!</h1><p>You can close this tab.</p>")

      try {
        const { tokens } = await oauth2Client.getToken(code)
        await fs.mkdir(path.dirname(TOKEN_PATH), { recursive: true })
        await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2))
        console.log(`✅ Token saved to ${TOKEN_PATH}`)
        console.log("\nYou can now use the Gmail CLI!")
      } catch (err) {
        console.error("❌ Failed to exchange code for token:", err)
      }

      server.close()
      process.exit(0)
    } else {
      res.writeHead(400, { "Content-Type": "text/html" })
      res.end("<h1>❌ No code received</h1>")
    }
  })

  server.listen(PORT, () => {
    console.log(`Listening on http://localhost:${PORT}`)
    console.log("\nOpening browser for authorization...\n")

    // Open browser
    import("node:child_process").then(({ exec }) => {
      exec(`open "${authUrl}"`)
    })
  })
}

main().catch(console.error)
