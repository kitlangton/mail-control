#!/usr/bin/env bun
import fs from "node:fs/promises"
/**
 * Mobile-friendly OAuth setup for Gmail API.
 * Shows a QR-code-friendly auth URL and accepts the code via simple web form.
 */
import { createServer } from "node:http"
import { networkInterfaces } from "node:os"
import path from "node:path"
import { google } from "googleapis"
import { defaultGmailTokenPath } from "./paths.js"

const CREDENTIALS_PATH = process.env.GOOGLE_CLIENT_SECRET_PATH ?? "./google-credentials.json"
const TOKEN_PATH = process.env.GOOGLE_TOKEN_PATH ?? defaultGmailTokenPath(CREDENTIALS_PATH)
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
]
const PORT = 8374

function getLanIp(): string {
  const nets = networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address
      }
    }
  }
  return "localhost"
}

async function main() {
  console.log("📧 Gmail OAuth Setup (Mobile-Friendly)\n")
  console.log(`Credentials: ${CREDENTIALS_PATH}`)
  console.log(`Token: ${TOKEN_PATH}\n`)

  const lanIp = getLanIp()
  console.log(`LAN IP: ${lanIp}`)

  // Load credentials
  const credentialsRaw = await fs.readFile(CREDENTIALS_PATH, "utf8")
  const credentials = JSON.parse(credentialsRaw)
  const { client_id, client_secret } = credentials.installed ?? credentials.web

  // Use localhost redirect - after auth, the URL bar will contain the code
  // even though the page won't load on mobile
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, "http://localhost")

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent", // Force consent to get refresh token
  })

  console.log("\n" + "=".repeat(60))
  console.log("Open this URL on your phone:")
  console.log("=".repeat(60))
  console.log(`\n${authUrl}\n`)
  console.log("=".repeat(60))

  // Start local server to accept the code
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost:${PORT}`)

    if (req.method === "GET" && url.pathname === "/") {
      // Show form to paste the code
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(`
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gmail OAuth</title>
  <style>
    body { font-family: system-ui; max-width: 500px; margin: 40px auto; padding: 20px; }
    h1 { color: #333; }
    textarea { width: 100%; height: 100px; font-size: 16px; margin: 10px 0; }
    button { background: #4285f4; color: white; border: none; padding: 15px 30px; font-size: 18px; cursor: pointer; border-radius: 4px; }
    button:hover { background: #3367d6; }
    .url { background: #f5f5f5; padding: 15px; border-radius: 4px; word-break: break-all; margin: 20px 0; }
    a { color: #4285f4; }
  </style>
</head>
<body>
  <h1>📧 Gmail OAuth Setup</h1>
  <p>1. Open the auth URL below and sign in with Google:</p>
  <div class="url"><a href="${authUrl}" target="_blank">Click here to authorize</a></div>
  <p>2. After authorizing, the page will fail to load (that's ok!). Copy the <code>code=</code> value from the URL bar and paste it below:</p>
  <p style="font-size: 12px; color: #666;">The URL will look like: http://localhost/?code=<b>4/0XXXXX...</b>&scope=...</p>
  <form method="POST" action="/submit">
    <textarea name="code" placeholder="Paste the authorization code here..." required></textarea>
    <button type="submit">Submit Code</button>
  </form>
</body>
</html>
      `)
      return
    }

    if (req.method === "POST" && url.pathname === "/submit") {
      // Parse form data
      let body = ""
      for await (const chunk of req) {
        body += chunk
      }
      const params = new URLSearchParams(body)
      const code = params.get("code")?.trim()

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" })
        res.end("<h1>❌ No code provided</h1><a href='/'>Try again</a>")
        return
      }

      try {
        const { tokens } = await oauth2Client.getToken(code)
        await fs.mkdir(path.dirname(TOKEN_PATH), { recursive: true })
        await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2))

        res.writeHead(200, { "Content-Type": "text/html" })
        res.end(`
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Success!</title>
  <style>
    body { font-family: system-ui; max-width: 500px; margin: 40px auto; padding: 20px; text-align: center; }
    h1 { color: #34a853; }
  </style>
</head>
<body>
  <h1>✅ Authorization successful!</h1>
  <p>Token saved to ${TOKEN_PATH}</p>
  <p>You can close this tab.</p>
</body>
</html>
        `)

        console.log(`\n✅ Token saved to ${TOKEN_PATH}`)
        console.log("\nYou can now use Gmail!")

        setTimeout(() => {
          server.close()
          process.exit(0)
        }, 1000)
      } catch (err) {
        console.error("❌ Failed to exchange code for token:", err)
        res.writeHead(500, { "Content-Type": "text/html" })
        res.end(`<h1>❌ Failed to exchange code</h1><pre>${err}</pre><a href='/'>Try again</a>`)
      }
      return
    }

    res.writeHead(404)
    res.end("Not found")
  })

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`\nOr open this on your phone to paste the code:`)
    console.log(`http://${lanIp}:${PORT}`)
    console.log(`\n(Also available at http://localhost:${PORT})`)
  })
}

main().catch(console.error)
