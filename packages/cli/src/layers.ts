import { NodeServices } from "@effect/platform-node"
import { Layer } from "effect"
import { layer as accountsLayer } from "./config.js"
import { layer as secretsLayer } from "./secrets.js"
import { envLayer } from "./support.js"

const platform = Layer.mergeAll(NodeServices.layer, envLayer())
const accounts = accountsLayer.pipe(Layer.provide(platform))
const secrets = secretsLayer.pipe(Layer.provide(platform), Layer.provide(accounts))

export const mailLayer = Layer.mergeAll(platform, accounts, secrets)
