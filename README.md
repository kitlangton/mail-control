# mail-control

A fast, scriptable command-line tool for **Gmail** and **iCloud** mail, built on
[Effect](https://effect.website). List, search, read, send, reply, forward,
download attachments, archive, trash, mark read, and one-click unsubscribe —
across as many accounts as you like, from one `mail` command.

Accounts are **user-defined in a config file**, so nothing about the tool is tied
to a particular person's setup. Add a Gmail or iCloud account by adding an entry
to `~/.mail-control/config.json`.

```bash
mail list -a all --max 20          # every configured inbox at once
mail search -a work "invoice"      # search one account
mail recent --since 24h --json     # machine-readable recent mail
mail send -a personal -t a@b.com -s "Hi" -b "Hello"
```

## Install

```bash
bun install
bun run build
```

The CLI entrypoint is `packages/cli/bin/mail`. During development run it with
`bun run mail ...`; to install a global `mail` shim, link the bin or add a shell
alias to `bun run --cwd /path/to/mail-control mail`.

## Configure accounts

mail-control reads `~/.mail-control/config.json`. Each entry under `accounts` has
a `type` (`gmail` or `icloud`) and the account's non-secret settings. The map key
is the account id you pass to `-a/--account`.

```jsonc
{
  "accounts": {
    "personal": { "type": "gmail" },
    "work": {
      "type": "gmail",
      "credentialsPath": "~/.mail-control/work-credentials.json",
      "tokenPath": "~/.mail-control/work-token.json"
    },
    "icloud": { "type": "icloud", "email": "you@icloud.com" }
  }
}
```

Copy [`config.example.json`](./config.example.json) to `~/.mail-control/config.json`
and edit. Set the home directory elsewhere with `MAIL_CONTROL_DIR`.

For a Gmail account, `credentialsPath` / `tokenPath` default to
`~/.mail-control/<id>-credentials.json` and `~/.mail-control/<id>-token.json`;
override them to point at existing files.

Then authorize each account with `mail auth <id>` and check setup at any time with
`mail accounts`:

```bash
mail accounts          # per-account: ready, or what's still needed
mail auth personal     # walks you through Gmail OAuth / iCloud password
```

## Credentials & secrets

**Rule of thumb: `config.json` is identity (safe to share); secrets live
elsewhere.** Secrets are resolved through an ordered chain so you are never
forced to use environment variables:

1. **Environment variable** — an override, ideal for CI/headless.
2. **`~/.mail-control/secrets.json`** — a `0600` file, the default local store.
3. *(pluggable)* an OS keychain provider can slot in as a later step.

### Gmail

Gmail uses OAuth, and `mail auth <id>` runs the whole flow:

1. Create an OAuth **Desktop** client in Google Cloud and download the client
   secret JSON. Running `mail auth <id>` *before* that file exists prints the
   exact console steps and the path to save it to.
2. Run `mail auth <id>` — it opens your browser, captures the grant, writes the
   token to the account's `tokenPath`, and verifies by reading one message.

On a headless machine (no browser), use `mail auth <id> --manual` to print a URL
and paste the resulting code.

### iCloud

iCloud uses an [app-specific password](https://support.apple.com/en-us/102654).
The easiest path is:

```bash
mail auth <id>     # prompts (hidden) and writes secrets.json (0600), then verifies
```

On a headless machine, pipe it instead: `printf '%s' "$APP_PW" | mail auth <id>`.

You can also provide it without the command — via the `MAIL_<ID>_APP_PASSWORD`
environment variable (override the name per account with `"appPasswordEnv"`), or a
`~/.mail-control/secrets.json` entry (`0600`):

```jsonc
{ "accounts": { "icloud": { "appPassword": "abcd-efgh-ijkl-mnop" } } }
```

IMAP/SMTP hosts default to iCloud's and can be overridden per account
(`imapHost`, `imapPort`, `imapSecure`, `smtpHost`, `smtpPort`, `smtpSecure`,
`mailbox`).

## Commands

```bash
# Set up
mail accounts               # list configured accounts and their setup status
mail auth <id>              # authorize an account (Gmail OAuth / iCloud password)
mail auth <id> --manual     # headless: paste a code instead of opening a browser

# Read
mail list    [-a <id>|all] [--unread|--read] [-q query] [--max N] [--mailbox M]
mail search  [-a <id>|all] <query> [--max N]        # searches beyond the inbox
mail recent  [-a <id>|all] --since 24h [--max N]    # 24h, 2d, 6w, 12mo, 1y
mail read     -a <id> <message-id> [--mailbox M]
mail download -a <id> <message-id> -o ./dir

# Write (Gmail supports all; iCloud supports send)
mail send    -a <id> -t to@x.com -s "Subject" -b "Body" [-A file]
mail reply   -a <id> <message-id> -b "Body"
mail forward -a <id> <message-id> -t to@x.com

# Mutate (Gmail; iCloud supports archive/trash)
mail archive     -a <id> <message-id>
mail trash       -a <id> <message-id>
mail mark-read   -a <id> <message-id>
mail unsubscribe -a <id> <message-id>
```

`-a/--account` accepts any id from your config, or `all` (default for
`list`/`search`/`recent`). Add `--json` to any read/mutation command for
machine-readable output. Use `-f/--body-file` for long message bodies.

Capabilities are determined by account **type**: Gmail supports every command;
iCloud supports read, send, archive, and trash.

## Security notes

- `config.json` and `secrets.json` are written `0600`.
- Secrets never appear in `config.json`, so it is safe to commit or share.
- `.env` and credential/token files are gitignored.
- Tokens and passwords are held as Effect `Redacted` values and never logged.

## Agent skill

An agent skill for driving this CLI lives in
[`skills/mail-control/SKILL.md`](./skills/mail-control/SKILL.md).

## Development

```bash
bun run check-types
bun run test
bun run lint
```

The repo is a small workspace: `packages/gmail` is a standalone Effect-based Gmail
client, and `packages/cli` is the multi-account CLI that unifies Gmail and iCloud.
