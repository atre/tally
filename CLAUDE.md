# tally

Claude Code token telemetry over local `~/.claude/projects/*/*.jsonl`. Output
is a compact digest (totals, by project/tool/model, heaviest sessions, leak
findings) — keep it a digest; guard compactness like squirt does.

## Stack
- TypeScript 5.x, Node ≥ 20, ESM only. No runtime deps so far — not a rule.

## Commands
- `npm run build` / `npm test` / `npm run lint` — same shape as squirt.
- `node dist/index.js --since 7d` runs against real transcripts; `--dir test/fixtures` for the synthetic one.

## Architecture
- `src/parse.ts` — `TranscriptParser` (incremental, line-by-line, emits turn/started/completed events) + `parseTranscript` batch wrapper; dedupes usage by `requestId`; pairs `tool_use` ↔ `tool_result` by id; sizes results; also emits `HookOutput`s from `type: "attachment"`/`hook_success` records. Batch scan and `trace` share it.
- `src/scan.ts` — walks projects dir, mtime-prefilters files, builds sessions; dedupes requestId/call-id/hook-output-uuid ACROSS files (resume replays); session `ctx` series is main-loop only (sidechain stays in totals).
- `src/analyze.ts` — aggregates + leak findings. `long-context` (session-level: avg ctx > `--ctx-limit`) always renders FIRST — it's the real bill. Tool-call buckets: each call lands in the FIRST bucket that claims it (order matters: retries → errors → log-dump → read-full-file → huge → big → subagents). `hook-output` (per-hookEvent token totals from `Scan.hookOutputs`, main-loop only) always renders LAST — fixed overhead you configured yourself, not a leak to chase.
- `src/render.ts` — text digest + JSON + markdown (`--md`, same content discipline as text). `heaviest` is uncapped on `Report` (so `--by session` can show all of it) — `renderText`/`renderMd`/`renderJson` each cap it back to `top` themselves; don't `JSON.stringify(report)` or persist a `Report` directly without capping first.
- `src/cli.ts` — hand-rolled args (`--since 7d|24h|2w|all|ISO`, `-p`, `--top`, `--ctx-limit 150k`, `--json`, `--md`, `--cost`, `--by session|day`, `--session <id-prefix>`, `--brief`, `--poolpool [url]`, `--dir`) + `trace`/`snap`/`diff`/`hook`/`hooks`/`tools` subcommands.
- `src/trace.ts` — live view: picks the most recent transcript (or `--session`/`-p`), one line per turn (ctx, Δ, out, biggest tool span + bucket tag), ⚠ on limit crossings and ×3 repeats; `--follow` tails by polling. A turn's line is emitted when its results are in or the next turn arrives.
- `src/hooks.ts` — `tally hook <name>` (`ctx-guard`, `pre-bash`, `pre-read`, `post-tool`, `post-bash-mark`, `stop-feedback`): reads a Claude Code hook event from stdin, rewrites via `updatedInput` when the fix is mechanical, blocks (exit 2) only when it isn't. Never exit 2 from `ctx-guard` — it must not block a tool call. Logs every block/rewrite to `${TALLY_HOME}/guard.log`. `tally hooks --install|--print|--list|--suggest` wires/prints/lists them (7 entries, 6 hooks; idempotent merge into `.claude/settings.json`) — single owner of the guard hooks: `--install` absorbs the hand-written predecessors `pre-bash` covers (inline curl|sh one-liner, `~/.claude/hooks/sed-guard.sh` — `absorbLegacy`, backup `settings.json.bak-tally-install-<YYYYMMDD>` first, `--keep-legacy` skips), delegates the squirt guard to `squirt init --claude [--global]` when squirt's on PATH and none is wired (`runSquirtInit` injectable), never touches `squirt-guard.sh` or anything else, and writes nothing when there's no semantic change. `--list` tags every configured hook (`origin` last column: `tally`/a path under `hooksDir`/`squirt`/`inline`); `--suggest` builds its regex from the bash head with the tool name stripped. `post-bash-mark`/`stop-feedback` use `parse.ts usedTools` — command-position match only, flags/paths aren't usage.
- `src/snap.ts` / `src/diff.ts` — `tally snap`/`tally diff`: snapshot a `Report` under `${TALLY_HOME:-~/.tally}` (default name = current ISO week), diff two `Report`s metric-by-metric and finding-by-finding.
- `src/pricing.ts` / `pricing.json` — `--cost`: opt-in $/Mtok table, clearly labelled an estimate. A malformed entry is dropped (stderr warning), never rendered as `$NaN`.
- `src/poolpool.ts` — `--poolpool [url]`: the one deliberate exception to "local read-only" below.
- `src/tools.ts` — `skillsReport`, `toolsReport`, `parseGuardLog`: data for `tally tools` (sunset review: < 5 calls/month outside a tool's own repo → flag).
- `test/fixtures/-Users-x-git-demo/s1.jsonl` — synthetic transcript (tool-call leaks, incl. one permission denial); `s2.jsonl` — context growth 50k→400k; `s5.jsonl` — one SessionStart `hook_success` attachment (~2k chars) + one turn. Extend when adding a finding.
- `test/fixtures/settings.sample.json` — one inline hook, one script-under-hooksDir hook, one tally-owned hook — for `listHooks` origin tests.

## Transcript facts (verified 2026-08)
- Records: `type` ∈ assistant|user|system|summary|attachment|…; only assistant/user/attachment matter.
- `assistant.message.usage`: input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens. Same usage repeated across records sharing `requestId`.
- `user.message.content[].tool_result` has `tool_use_id`, `content` (string | blocks), `is_error`.
- `attachment.type === 'hook_success'` = a hook's output; `attachment.hookEvent` (SessionStart/PreToolUse/PostToolUse/…), `attachment.hookName` (e.g. `SessionStart:startup`), `attachment.content` (what actually enters the model's context — an empty string means nothing did), `attachment.stdout` (raw process stdout, may be a JSON envelope never shown to the model — don't count this one). `attachment.toolUseID` is NOT a unique per-record id (every hook command in one matcher-less group shares it); dedupe on the record's own top-level `uuid` instead.
- Records carry `sessionId`, `cwd`, `timestamp`, `isSidechain`, `gitBranch`, `version`.

## Rules
- New finding → add to `analyze.ts` bucket order deliberately, add a fixture case + test.
- Never send data anywhere; local read-only — except `--poolpool`, which is opt-in (flag or `POOLPOOL_URL` env), fetches only from a URL the user gave it, and is documented as the exception, not folded quietly into the default path.
- Roadmap in PLAN.md. `snuff` before done (Stop hook runs it; hook no-ops when snuff isn't installed — then run `npm run lint && npm test && npm run build`).
