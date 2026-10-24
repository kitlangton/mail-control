import { takeJsonFlag } from "./control-contract.js"

// `--json` and `--envelope` may appear anywhere, but Effect CLI only accepts a
// flag after its own subcommand, so both are stripped before parsing.
// `--json` keeps the original bare JSON (arrays for list/search/recent);
// `--envelope` prints the control-contract envelope with coverage and warnings.
const raw = process.argv.slice(2)
const envelope = raw.includes("--envelope")
const { json, argv } = takeJsonFlag(raw.filter((arg) => arg !== "--envelope"))

export const outputMode = { json: json || envelope, envelope, argv } as const
