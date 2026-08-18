---
name: tally
description: Claude Code token telemetry — run `tally` to see where tokens go (per repo/tool/session) and which habits leak them. Use when the user asks about token usage, cost, context bloat, or wants to optimize their Claude Code workflow.
---

# tally

`tally [--since 7d] [-p <slug-substr>] [--top 5] [--ctx-limit 150k] [--json|--md|--brief]`
— reads local transcripts, prints a compact digest. Nothing leaves the machine.

## When to run it
- "where are my tokens going" / "why am I hitting limits" / "what's eating context" →
  `tally --since <window they name, default 7d>`.
- Mid-session, live — "is this getting heavy right now" → `tally trace` (most recent session,
  or `--session <id-prefix>`): one line per turn, ⚠ on threshold crossings and ×3 repeats.
  `--follow` tails it until ^C.
- A daily/SessionStart check that must stay tiny → `tally --brief` (≤ 12 lines: heaviest 3
  sessions + top 3 leaks) — this is what a SessionStart hook should call, never the full digest.
- "which of my own CLIs is worth keeping" → `tally tools` (< 5 calls/month outside its own
  repo → merge/archive candidate).

## Reading the digest
1. Lead with the `long-context` finding and the heaviest sessions' `>150k@turn` column —
   context × turns is the bill, and the crossing turn is where /compact or a new session
   should have happened.
2. Then top 2–3 leaks with the concrete hint (squirt for logs, `Read` with limit, stop repeating calls).
3. `hook-output` (if present) is fixed overhead from your own SessionStart/PreToolUse/PostToolUse
   hooks, not a leak to chase — but worth trimming if it's grown.
4. Don't paste the whole digest back — it's already compact; quote the lines that matter.

## Reports
For a report to keep or publish: `tally --md --since 7d`. For charts/automation: `--json` has
the per-turn context series per session. Weekly report in this repo:
`tally --md --since 7d > reports/$(date +%G-%V).md` (gitignored, local only).

## Hooks
`tally hooks --install [--global]` wires the live guards (ctx-guard nag, pre-bash/pre-read
rewrites, post-tool/post-bash-mark nudges, stop-feedback enforcement) into
`.claude/settings.json` — idempotent, never deletes a hook it didn't write. `tally hooks --list`
shows who owns each configured hook; `--suggest` proposes a guard from the top error command.
