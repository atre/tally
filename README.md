# tally

![CI](https://github.com/atre/tally/actions/workflows/ci.yml/badge.svg)

Claude Code token telemetry. Reads your local `~/.claude/projects` transcripts
and answers: where do my tokens actually go — per repo, per tool, per session —
and which habits leak them.

Built for the learning loop: measure first, then fix (compress big outputs with
[squirt](https://github.com/atre/squirt), `Read` with limits, stop re-reading,
shorter sessions). Nothing leaves the machine.

```bash
tally                    # last 7 days
tally --since 24h        # or 2w, all, ISO date
tally -p git-webapp      # one project (slug substring)
tally --ctx-limit 200k   # long-context threshold (default 150k)
tally --json             # machine output — schema below
tally --md               # markdown digest for weekly reports / artifacts
tally --md --since 7d > reports/$(date +%G-%V).md   # weekly report (reports/ is gitignored)
tally --brief            # ≤ 12 lines (SessionStart hook budget)
tally --cost             # est. $ per model from pricing.json — estimate, not a bill
tally --by session       # full heaviest-sessions table (no top cap); --by day: totals per UTC date
tally --session 68       # narrow the scan to one session (id prefix)
tally --poolpool [url]   # merge poolpool's per-project usage (opt-in; POOLPOOL_URL env)

tally trace              # most recent session, one line per turn
tally trace --follow     # tail the live session (^C to stop)
tally trace --session 68 # session-id prefix

tally snap [name]        # save a snapshot under ~/.tally (default: current ISO week)
tally diff [name]        # live scan vs snapshot, metric-by-metric + finding-by-finding
tally tools              # personal CLI / skill invocations per month; < 5 outside its own repo → sunset candidate
tally tools --builtin    # per-built-in-tool call counts (Bash/Read/Agent/…) across projects, sidechain calls included
tally hooks --suggest    # top error command heads → a guard worth adding (print-only)
tally hooks --list       # every configured hook + who owns it (tally / squirt / path / inline)
```

```
--json top-level keys: sessionCount (number — session OBJECTS live in
heaviest[]), files, turns, ctxLimit, usage {input, output, cacheRead,
cacheCreate}, byProject[], byDay[], byTool[], byHead[], byModel[],
findings[] {key, title, count, tokens, hint, samples[]},
heaviest[] {id, project, turns, avgContext, peakCtx, crossLimit,
burnedAbove, ctxSeries[]}.
jq starter: tally --json | jq '.heaviest[] | {id, ctx: .ctxSeries}'
```

## What it shows

```
tally — 7d window · 58 transcripts · 54 sessions · 5,467 API turns
tokens  out 3.5M · cache-write 11.3M · cache-read 1283.3M · uncached-in 11k
avg context per turn ~235k tok · fresh tokens/turn ~2.7k

by project                  sess  turns   out    cache-w  tool-out
  git/webapp                  16   2305   1.4M     4.0M     971k
  …
by tool                     calls  result-tok  err
  Bash                        3623        1.3M  142
  Read                         711        811k    6
  …
by command head             calls  result-tok  err
  npm                          412        380k   31
  kubectl                      190        212k    4
  …
heaviest sessions (cache-read = context × turns; the real bill)
  f03ce8a9  git/webapp  602 turns  ctx ~519k/turn  read 312.6M  out 430k  >150k@t41
  …
leaks (est. tokens that entered context)
  Long-context sessions (avg ctx > 150k)  × 12  ~98.4M → /compact earlier or start a new session
      ↳ f03ce8a9 git/webapp: crossed 150k at turn 41/602, peak 780k, ~53.1M burned above 150k → /compact or new session at turn 41
  Compact loop (≥3 compactions in one session)  ×  1  ~465k → raise/remove the compaction cap (autoCompactWindow) or split the task across sessions
      ↳ a1b2c3d4 git/webapp: 3 compactions in 10 turns, compacts near ~155k, lands at ~45k
  Big tool results (~2k–10k tokens)   × 165  ~563k  → trim before it enters context
      ↳ Bash: cat src/check.ts src/cli-output.ts → ~6,682 tok
  Read of long files without limit    ×  18  ~145k  → use limit/offset …
  Permission denials / interruptions  ×   3  ~  1k  → ask before risky commands, or allow-list the safe ones
  Tool errors                         × 172  ~ 47k  → each error = a wasted round-trip; the top command is where to fix a flag, path, or permission
      ↳ Bash sed ×18 ~9,444 tok · e.g. cd ~/git/demo-app && sed -i '' 's/DEBUG=true/…
  Identical tool call repeated        × 149  ~ 27k  → cache it, or trust it
  Raw log dumps in Bash               ×  14  ~8.5k  → pipe through squirt
  Hook output injected into context   ×   9  ~4.2k  → SessionStart/hook printers add up on top of the digest itself — keep each one to a budget
      ↳ SessionStart ×3 ~2,847 tok
```

**Reading it:** `cache-read` is context size × turns — long sessions with a fat
context are the real cost, not the occasional big `cat`. That's why
long-context always renders first: `>150k@turn` tells you where the session
should have been compacted or split, and "burned above 150k" is what those
extra turns re-read every request. `compact-loop` renders right after it — a
different shape of the same problem: ≥3 compactions in one session means
`autoCompactWindow` keeps rebuilding context just to re-compact it; `marathon`
(>500 turns, never compacted) comes third. The tool
buckets below are the habits that fatten context; each call lands in exactly
one bucket, biggest first.

## Live view (`tally trace`)

Same parser, live: one line per turn against the newest (or named) transcript —
context size, delta, output, the biggest tool span with duration and bucket tag —
plus ⚠ warnings the moment context crosses `--ctx-limit` (and 2×) or the same
call repeats ×3. `--follow` keeps tailing; run it in a second pane while a
session works.

```
t23   14:02:11  ctx   142k    +9k  out   1.2k  Read: src/scan.ts →2.1k tok ⏱0.4s
t24   14:02:38  ctx   152k   +10k  out   0.8k  Bash: npm test →6.7k tok ⏱8.1s [big]
      ⚠ ctx crossed 150k at turn 24 — /compact or new session
```

`tally --brief` prints the same digest compressed to ≤ 12 lines (heaviest 3
sessions + top 3 leaks, no samples) — sized for a SessionStart hook budget.

## Hooks (`tally hook`)

Claude Code hooks that read a hook event JSON from stdin and print a hook
response JSON (or, for a hard block, exit 2 with a stderr message):

- **`ctx-guard`** (PreToolUse `.*` / UserPromptSubmit) — when context is over
  the limit, nags via `additionalContext`: finish the step, then delegate to a
  subagent or tell the user to `/compact` / start fresh. Throttled (every 10
  calls, every 5 once past 2× the limit) so it reminds instead of spamming.
  Never blocks.

  The limit is **75% of the session's context window**, not a flat number: 150k
  on a 200k model (unchanged), 750k on a 1M one. The window is inferred from the
  largest context the session has actually carried, since the transcript records
  no window field — so a 1M session is treated as 200k until it first exceeds
  200k, then promotes itself. `TALLY_CTX_LIMIT` overrides it outright.

  "Context" is the **median of the last three** main-loop records, not the last
  one. Some turns bill ~2× the real context into the session — a consultation
  tool that forwards the whole transcript back through it, for instance — and a
  single such record as "current context" fired the guard at twice the truth,
  then dropped back next turn (seen live as 230k → 465k → 240k). A median over
  three consecutive records cannot return an outlier and costs one turn of lag
  on genuine growth, which is a few k.
- **`pre-bash`** (PreToolUse `Bash`) — rewrites the command via `updatedInput`
  when the fix is mechanical: a raw log dump (`kubectl logs`, `docker logs`,
  `cat *.log`, …) gets ` | squirt` appended when squirt is on `PATH`; macOS
  `sed -i` becomes `sed -i ''`. Blocks (exit 2) only when there's no safe
  rewrite — `curl|sh` style installers. `TALLY_NO_REWRITE=1` turns rewrites
  back into plain blocks.
- **`pre-read`** (PreToolUse `Read`) — a file over 300 lines read without
  `limit` gets `updatedInput.limit = 300` instead of loading the whole thing;
  same `TALLY_NO_REWRITE=1` escape hatch blocks instead.
- **`post-tool`** (PostToolUse `.*`) — a result over ~8k chars gets a
  `additionalContext` nudge to trim next time; never blocks (the tool already
  ran).
- **`post-bash-mark`** (PostToolUse `Bash`) — notes which personal CLIs
  (looksy/peep/squirt/tally/snuff/brief, or `TALLY_TOOLS`) a session actually
  invoked from outside their own repo — command position only, so `pulse --brief`
  or `cd ~/git/brief` don't count. Tool calls made inside a subagent (`agent_id`
  in the hook input) don't count either — the parent session isn't nagged for a
  worker's probe. Never blocks.
- **`stop-feedback`** (Stop) — blocks (exit 2) when a marked tool's
  `~/git/<tool>/FEEDBACK.md` wasn't touched since; the one hook that can block.

`tally hooks --install` wires all six (7 entries: `ctx-guard` on both
PreToolUse and UserPromptSubmit) into `.claude/settings.json` (`--global`
for `~/.claude/settings.json`; default is `<current directory>/.claude/` — run
it from the project root, same directory you'd launch `claude` from).
It is the single owner of the guard hooks: it also **absorbs** the hand-written
predecessors `pre-bash` now covers — the inline `curl|sh` one-liner and
`~/.claude/hooks/sed-guard.sh` — printing `absorbed: <origin>` per entry, after
writing `settings.json.bak-tally-install-<YYYYMMDD>` (`--keep-legacy` skips
this). A leftover `~/.claude/hooks/squirt-guard.sh` (retired 2026-08-18 —
`pre-bash` does that job) is absorbed like `sed-guard.sh`; pass `--keep-legacy`
to keep hand-written hooks. Idempotent — a second run writes nothing (a hand-formatted
file stays byte-identical, no backup) — and leaves every other hook alone.
`tally hooks --print` shows what would be written without touching anything.
`tally hooks --list [--global]` flattens every hook currently in
`.claude/settings.json` and tags who owns each one — `tally`, `squirt` (or
the literal path of a script under `~/.claude/hooks`), or `inline`; without
`--global` and no local `.claude/settings.json` it says so and points at
`--global`.
`--target <config-dir>` points `--install`/`--list` at `<config-dir>/settings.json`
directly instead of `~/.claude/settings.json` — for a second Claude Code
instance whose config dir already IS the `.claude`-equivalent, e.g.
`tally hooks --install --target ~/.claude-dev`. Mutually exclusive with `--global`.

## Install

Node ≥ 20, no runtime deps so far.

```bash
npm install -g github:atre/tally
# or: git clone … && npm i && npm link
```

## Notes

- Usage is deduped by `requestId` — Claude Code writes several `assistant`
  records per API request, all carrying the same usage.
- Token estimates for tool results are `chars / 4`; usage numbers are exact
  (from the API's `usage` block).
- Sidechain (subagent) records count in totals but are excluded from leak
  findings and from per-session context series — crossing turn, peak, and
  burned-above-limit describe the main loop; the parent's `Agent` call is the
  thing to review.
- Usage is also deduped across files, so resumed sessions that replay records
  into a new transcript don't double-count.
- `TALLY_PROJECTS` / `--dir` override the transcripts directory.

## License

MIT
