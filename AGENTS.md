# mail-control

## Private Kit Tool

Commit and push straight to `main`, no PRs. Merge any open PR without asking.
After pushing, update the installed copy. See `~/code/control/AGENTS.md`.

CLI output must await writes (`src/output.ts` / `printJson`) before NodeRuntime exits;
large plain-text bodies can truncate too. Keep the slow-pipe synthetic regression test.
Import Google's Gmail entry point, not the full googleapis barrel, on CLI read paths.
