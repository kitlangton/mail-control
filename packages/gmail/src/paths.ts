import os from "node:os"
import path from "node:path"

export const defaultGmailCredentialsPath = (account?: string): string => {
  const suffix = account ? `-${account}` : ""
  return path.join(os.homedir(), ".mail-control", `google-credentials${suffix}.json`)
}

export const defaultGmailTokenPath = (credentialsPath: string): string => {
  const extension = path.extname(credentialsPath) || ".json"
  const baseName = path.basename(credentialsPath, extension)
  const tokenBaseName = baseName.startsWith("google-credentials")
    ? baseName.replace(/^google-credentials/, "gmail-token")
    : `${baseName}-token`

  return path.join(path.dirname(credentialsPath), `${tokenBaseName}${extension}`)
}
