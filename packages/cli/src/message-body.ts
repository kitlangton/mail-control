import TurndownService from "turndown"
import type { MailMessageBody } from "./types.js"

const turndown = new TurndownService({
  headingStyle: "atx",
  hr: "---",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
})

turndown.remove(["script", "style", "meta", "link"])
turndown.addRule("readableLinks", {
  filter: "a",
  replacement: (content) => content.trim(),
})
turndown.addRule("terminalImages", {
  filter: "img",
  replacement: (_content, node) => {
    if (!("getAttribute" in node) || typeof node.getAttribute !== "function") return ""
    const alt = node.getAttribute("alt")?.trim() ?? ""
    if (alt.length < 20 || alt.toLowerCase().includes("logo")) return ""
    return `\n\n_Image: ${alt}_\n\n`
  },
})

const cleanText = (value: string) =>
  Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint === 0x00a0 || codePoint === 0x2007 || codePoint === 0x202f) return " "
    if (
      codePoint === 0x00ad ||
      codePoint === 0x034f ||
      (codePoint >= 0x200b && codePoint <= 0x200f) ||
      codePoint === 0x2060 ||
      codePoint === 0xfeff
    ) {
      return ""
    }
    return character
  }).join("")

const normalizeLines = (value: string, trimLayoutIndentation: boolean) => {
  const normalized: string[] = []
  let inCodeFence = false

  for (const rawLine of cleanText(value).replace(/\r\n?/g, "\n").split("\n")) {
    const line = trimLayoutIndentation && !inCodeFence ? rawLine.trim() : rawLine.trimEnd()
    if (line.trimStart().startsWith("```")) inCodeFence = !inCodeFence
    if (line.trim().length === 0) {
      if (normalized.at(-1) !== "") normalized.push("")
    } else {
      normalized.push(line)
    }
  }

  while (normalized[0] === "") normalized.shift()
  while (normalized.at(-1) === "") normalized.pop()
  return normalized.join("\n")
}

const joinSoftWrappedParagraphs = (value: string) => {
  const lines = value.split("\n")
  const joined: string[] = []

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ""
    const previous = joined.at(-1)
    const next = lines[index + 1]
    const canJoin =
      line === "" &&
      previous !== undefined &&
      next !== undefined &&
      /^[a-z]/.test(next) &&
      !/[.!?:;]$/.test(previous) &&
      !/^(?:[-+*>#]|```|!\[)/.test(previous)

    if (canJoin) {
      joined[joined.length - 1] = `${previous} ${next}`
      index++
    } else {
      joined.push(line)
    }
  }

  return joined.join("\n")
}

export type MessageBodyContent =
  | { readonly format: "markdown"; readonly content: string }
  | { readonly format: "text"; readonly content: string }

export const messageBodyContent = (
  message: Pick<MailMessageBody, "body" | "from" | "htmlBody">,
): MessageBodyContent => {
  const usePlainText = !message.htmlBody || message.from.toLowerCase().includes("notifications@github.com")
  return usePlainText
    ? { format: "text", content: normalizeLines(message.body, false) }
    : {
        format: "markdown",
        content: joinSoftWrappedParagraphs(normalizeLines(turndown.turndown(message.htmlBody ?? ""), true)),
      }
}
