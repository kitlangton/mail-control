import { existsSync } from "node:fs"
import * as path from "node:path"
import { NodeFileSystem } from "@effect/platform-node"
import { ConfigProvider, Layer } from "effect"

export interface Colorizer {
  readonly enabled: boolean
  readonly colorize: (code: number) => (value: string) => string
}

export const createColorizer = (enabled = Boolean(process.stdout.isTTY)): Colorizer => {
  const colorize = (code: number) => (value: string) => (enabled ? `\u001b[${code}m${value}\u001b[0m` : value)
  return { enabled, colorize }
}

export const envLayer = (envPath = ".env") =>
  existsSync(envPath)
    ? ConfigProvider.layerAdd(ConfigProvider.fromDotEnv({ path: envPath })).pipe(Layer.provide(NodeFileSystem.layer))
    : Layer.empty

export const envLayerFrom = (dirname: string, relativePath = "../../../.env") =>
  envLayer(path.resolve(dirname, relativePath))
