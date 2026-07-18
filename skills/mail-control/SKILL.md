---
name: mail-control
description: Use the local mail-control CLI for Gmail and iCloud email tasks. Use when asked to list, search, read, inspect recent mail, unsubscribe, trash/delete mail, send, reply, forward, download attachments, archive, mark read, set up mail accounts, debug mail-control, or operate email from the terminal instead of a browser.
---

# Mail Control

Use the local `mail` CLI instead of browser automation when it can complete the email task.

## Command Resolution

- Use the globally linked `mail` command. Verify it with `command -v mail` and `mail --help`; the check passes when help lists the `list`, `search`, `send`, and `accounts` subcommands.
- If `mail` resolves to `/usr/bin/mail` or shows `mail [-dEiInv]`, repair the global link from `packages/cli` with `bun link`, then verify `mail --help` again. A stale `~/.bun/bin/mail` symlink may point to the retired `@hub/mail-cli`; remove that obsolete global package with `bun remove --global @hub/mail-cli` before relinking.
- Treat `bun run mail ...` as a temporary diagnostic fallback only. Do not leave the environment using the repo-local command when the requested global CLI can be repaired.
- Confirm subcommand flags with `<resolved-command> <subcommand> --help` before relying on remembered flags.

## Accounts

Accounts are defined by the user in `~/.mail-control/config.json` (override the
directory with `MAIL_CONTROL_DIR`). Each account has an id (the map key) and a
`type` of `gmail` or `icloud`.

- Pass `-a <id>` / `--account <id>` whenever the account matters.
- `all` is the default for `list`, `search`, and `recent`; use a concrete id for single-message mutations.
- Discover configured ids by reading `config.json` or running a command and seeing the `[id]` tags in output.
- Capabilities depend on type: Gmail supports every command; iCloud supports read, send, archive, and trash.
- For iCloud mailbox-specific reads/lists/searches, pass `--mailbox <name>` (e.g. `"Sent Messages"`, `Archive`).

## Credentials

Do not print credential, token, or password contents.

- `config.json` holds identity only (safe to share). Secrets never live there.
- Run `mail accounts` to see, per account, whether it is `ready` or what setup it still needs.
- Run `mail auth <id>` to set an account up: for Gmail it runs the OAuth browser flow (or `--manual` for headless) after guiding credential creation; for iCloud it prompts for the app-specific password and writes `~/.mail-control/secrets.json` (0600). Both verify by reading one message.
- Under the hood: Gmail uses OAuth credential + token JSON (`credentialsPath` / `tokenPath`, default `~/.mail-control/<id>-credentials.json` and `<id>-token.json`); iCloud resolves its password from `MAIL_<ID>_APP_PASSWORD` (or the account's `appPasswordEnv`) then `secrets.json`.

## Workflows

Finding mail:

```bash
mail list                          # inbox-scoped listing, all accounts
mail list -a personal --unread
mail list -a work -q "from:someone@example.com"
mail search "invoice"              # broader search, not inbox-only
mail recent --since 24h
mail recent --since 48h --json
mail read -a personal <message-id>
mail read -a icloud --mailbox "Sent Messages" <message-id>
```

Use `--json` for machine-readable output from `list`, `search`, `recent`, `read`, `download`, and mutation commands. Prefer JSON for scripts instead of parsing pretty terminal output.

Daily email review:

The goal is inbox zero across all accounts: a clear picture of every inbox, focused on unread mail, with explicit recommendations for what to archive, what to unsubscribe from, and what needs a response. Work across all inboxes at once with `mail list -a all` unless the user narrows the account.

1. Start with simple listings, covering all inboxes.

```bash
mail list -a all --max 80 --json          # every inbox at once (inbox-scoped)
mail recent --since 24h --max 80 --json   # what's new
mail recent --since 7d --unread --max 80 --json
```

2. Summarize every inbox into buckets, prioritizing unread but covering all messages:

- Needs response or decision.
- Security/account/billing notices worth reading.
- Safe archive candidates: already-handled notifications, receipts, calendar cancellations, no-action-required product notices.
- Possible unsubscribe candidates: recurring marketing/newsletters/promos the user is unlikely to want.
- Leave alone: personal, transactional, legal, medical, financial, or ambiguous messages.

State, per message, whether to archive, unsubscribe, respond, or leave it — the point is to drive the inbox toward zero, not just list mail.

3. Propose exact actions before mutating mail:

```text
Archive: account:id subject...
Unsubscribe: account:id sender subject...
Read/respond: account:id subject...
Leave: account:id subject...
```

4. Only after explicit approval, run `mail archive`, `mail unsubscribe`, `mail mark-read`, or `mail trash` for the specific approved messages/senders.

Sending mail:

```bash
mail send -a personal -t recipient@example.com -s "Subject" -b "Body"
mail send -a personal -t one@example.com -t two@example.com -s "Subject" -f body.txt
mail send -a personal -t recipient@example.com -s "Subject" -b "Body" -A file.pdf
```

Application-managed inbox smoke tests:

1. Resolve the exact recipient from the application's provider configuration or provider API. Do not guess an address from product branding or treat a mailbox search as authoritative.
2. Send from one concrete configured account with a unique marker and an explicit no-action/no-reply body.
3. Verify one provider intake by that marker before concluding the mail path works. For cursor-based consumers, establish a new-only baseline first; never rewind a production cursor merely to manufacture a test message.

Replying and forwarding:

```bash
mail reply -a personal <message-id> -b "Reply body"
mail forward -a personal -t recipient@example.com <message-id>
```

Attachments and mutations:

```bash
mail download -a personal -o /tmp/mail-attachments <message-id>
mail archive -a personal <message-id>
mail archive -a icloud <message-id>
mail trash -a personal <message-id>
mail mark-read -a personal <message-id>
mail unsubscribe -a personal <message-id>
```

## Safety

- For sending, replying, forwarding, archiving, trashing, marking read, or unsubscribing, make sure the user's intent is clear before executing the command.
- Prefer `list`, `search`, and `read` before acting on a message unless the user gives an exact account and message ID.
- Never run `trash` or other destructive mail commands unless the user clearly approved the specific sender/message/action.
- Use `-f <body-file>` for longer drafted emails so the body is inspectable and shell quoting is not fragile.
- Never expose secrets from `~/.mail-control`, `.env`, Gmail tokens, OAuth credentials, or iCloud app passwords.

## Self-Iteration

If the CLI fails or appears stale, do not stop at the first error:

- Inspect `packages/cli/src` for CLI behavior and `packages/gmail/src` for Gmail auth/API behavior.
- Re-run with a narrower account, mailbox, query, or message ID to isolate the failure.
- For code changes, verify with `bun run check-types` and targeted tests; use `bun run test` when relevant.

Prefer small local fixes when they unblock the requested email task and are low risk.
