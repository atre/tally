import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BIG_RESULT_CHARS, DEFAULT_CTX_LIMIT, bashLooksLikeLogDump, stripForCurlShCheck, stripNonCodeSpans } from './analyze.js';
import { cap, fmt, pad } from './render.js';
import { escapeRegExp, estTokens, isWithinDir, usedToolsCertain } from './parse.js';

export interface HookResult {
  exit: number;
  stdout: string; // JSON payload for Claude Code, printed to stdout when non-empty
  message?: string; // stderr text for a block (exit 2)
}

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  stop_hook_active?: boolean; // Stop event: true when this is itself a re-invocation from a prior Stop block — never re-block, or it loops
}

function homeFor(env: NodeJS.ProcessEnv): string {
  return env.TALLY_HOME || join(homedir(), '.tally');
}

/** Standard context windows, smallest first. `inferWindow` picks the smallest one that can
 *  actually hold the largest context this session has been observed to carry. */
const CTX_WINDOWS = [200_000, 1_000_000] as const;

/** Fraction of the window at which the guard starts nagging. 0.75 × 200k = 150k, i.e. exactly
 *  the flat DEFAULT_CTX_LIMIT this used to hardcode — the default is unchanged for a 200k
 *  session, it just stops being wrong for a larger one. */
export const CTX_LIMIT_FRACTION = 0.75;

/** Smallest standard window that fits `peak`; the largest known window once nothing fits. */
export function inferWindow(peak: number): number {
  return CTX_WINDOWS.find((w) => peak <= w) ?? CTX_WINDOWS[CTX_WINDOWS.length - 1];
}

/** Median of up to the last 3 values (fewer near the start → the last value). */
function median3(series: number[], i: number): number {
  const w = series.slice(Math.max(0, i - 2), i + 1);
  return [...w].sort((a, b) => a - b)[Math.floor(w.length / 2)];
}

/** MAIN-LOOP `assistant` cache-read tokens — same "context" convention as
 *  analyze.ts/scan.ts/trace.ts (cache-read alone, not input+cacheRead+cacheCreate; sidechain
 *  turns excluded so a subagent call doesn't make ctx-guard react to the wrong session's size).
 *  Reads only the file's tail for speed.
 *
 *  `cacheRead` is the MEDIAN of the last three such records, not the last one. Some turns record
 *  roughly double the session's real context — a consultation/advisor tool that forwards the whole
 *  transcript back through the same session bills its own request here — and a single one of those
 *  as "current context" made the guard fire at 2× the truth, then drop back on the next turn.
 *  Observed on a real transcript as 230k → 465k → 240k. A median over three consecutive records
 *  cannot return an outlier, tracks genuine growth within one turn, and leaves a normal tail value
 *  untouched.
 *
 *  `peak` is the largest SMOOTHED value in the tail — smoothing first matters, or the same spikes
 *  would promote a 200k session to the 1M window and silence the guard entirely. */
export function lastUsage(transcriptPath: string): { cacheRead: number; peak: number } | null {
  let fd: number;
  try {
    fd = openSync(transcriptPath, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const readSize = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, size - readSize);
    const lines = buf.toString('utf8').split('\n');
    const series: number[] = [];
    for (const line of lines) {
      if (!line.startsWith('{')) continue;
      let o: { type?: string; isSidechain?: boolean; message?: { usage?: Record<string, number> } };
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type === 'assistant' && !o.isSidechain && o.message?.usage) {
        series.push(o.message.usage.cache_read_input_tokens ?? 0);
      }
    }
    if (series.length === 0) return null;
    let peak = 0;
    for (let i = 0; i < series.length; i++) peak = Math.max(peak, median3(series, i));
    return { cacheRead: median3(series, series.length - 1), peak };
  } finally {
    closeSync(fd);
  }
}

interface CtxState {
  count: number;
  lastEmit: number;
}

function loadCtxState(path: string): CtxState {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CtxState;
  } catch {
    return { count: 0, lastEmit: 0 };
  }
}

function saveCtxState(path: string, state: CtxState): void {
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(state));
  } catch {
    // best-effort: never let a state-file write failure block the tool call
  }
}

/** PreToolUse (any tool) + UserPromptSubmit: nag when context is over the limit. The *message*
 *  is throttled (reminds rather than spams) — the tail read that decides whether ctx is over the
 *  limit in the first place always happens; there's no way to know if a nag is due without it,
 *  and each hook call is a fresh process anyway (no in-memory state to gate the read on). Never
 *  exit 2 — this must not block work. */
function runCtxGuard(input: HookInput, env: NodeJS.ProcessEnv): HookResult {
  if (!input.transcript_path) return { exit: 0, stdout: '' };
  const usage = lastUsage(input.transcript_path);
  // Window-aware, because the flat 150k default is only right for a 200k model: on a
  // 1M-context session it nagged from 15% full onward and told the model to hand off or
  // /compact when nothing was close to full. TALLY_CTX_LIMIT still wins outright.
  const window = inferWindow(usage?.peak ?? 0);
  const limit = Number(env.TALLY_CTX_LIMIT) || Math.round(CTX_LIMIT_FRACTION * window) || DEFAULT_CTX_LIMIT;
  const statePath = join(homeFor(env), 'ctx', input.session_id || 'unknown');
  if (!usage || usage.cacheRead <= limit) {
    // back under the limit (or nothing to read yet) — reset so a later crossing nags from the top again
    if (existsSync(statePath)) saveCtxState(statePath, { count: 0, lastEmit: 0 });
    return { exit: 0, stdout: '' };
  }
  const is2x = usage.cacheRead >= 2 * limit;
  const every = Number(env.TALLY_CTX_EVERY) || (is2x ? 5 : 10);
  const state = loadCtxState(statePath);
  state.count++;
  if (state.lastEmit !== 0 && state.count - state.lastEmit < every) {
    saveCtxState(statePath, state);
    return { exit: 0, stdout: '' };
  }
  state.lastEmit = state.count;
  saveCtxState(statePath, state);
  const prefix = is2x ? '⚠⚠ ' : '';
  const additionalContext = `${prefix}tally: ctx ~${fmt(usage.cacheRead)} (limit ${fmt(limit)} of a ~${fmt(window)} window) — heads-up, not a stop order: each further turn re-bills this context; prefer finishing with what's already loaded, hand off to a subagent (if you have the Agent tool), or suggest /compact / a new session to the user`;
  return {
    exit: 0,
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name || 'PreToolUse', additionalContext } }),
  };
}

/** `ts rule outcome` — read by tools.ts's parseGuardLog for the eventual `tally tools` sunset review. */
function logGuard(env: NodeJS.ProcessEnv, rule: string, outcome: 'blocked' | 'rewritten'): void {
  try {
    const home = homeFor(env);
    mkdirSync(home, { recursive: true });
    appendFileSync(join(home, 'guard.log'), `${new Date().toISOString()} ${rule} ${outcome}\n`);
  } catch {
    // best-effort: a log-write failure must never block the tool call
  }
}

function allow(input: HookInput, updatedInput: Record<string, unknown>, reason: string, env: NodeJS.ProcessEnv, rule: string): HookResult {
  logGuard(env, rule, 'rewritten');
  return {
    exit: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: { hookEventName: input.hook_event_name || 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: reason, updatedInput },
    }),
  };
}

function block(message: string, env: NodeJS.ProcessEnv, rule: string): HookResult {
  logGuard(env, rule, 'blocked');
  return { exit: 2, stdout: '', message };
}

// (sudo|env|exec )? — the common wrappers between a pipe and the shell name; still a regex,
// not a real shell parser, so this is a meaningful-effort net, not a guarantee. Two separate
// checks, not one "curl ... | sh" pattern — the single-pattern version couldn't cross a SECOND
// pipe stage (curl ... | tee x | bash), since [^|]* can't match across a `|` it needs to stop at.
const HAS_CURL_WGET_RE = /\b(curl|wget)\b/;
const PIPES_TO_SHELL_RE = /\|\s*(sudo\s+|env\s+|exec\s+)?(ba|z)?sh\b/;
function looksLikeCurlPipeShell(command: string): boolean {
  const sanitized = stripForCurlShCheck(command);
  return HAS_CURL_WGET_RE.test(sanitized) && PIPES_TO_SHELL_RE.test(sanitized);
}
// (^|[;&|\n]\s*) — sed -i must start a command (or follow a separator, including a newline —
// Bash tool calls are frequently multi-line), not appear anywhere in the string — otherwise this
// rewrites text inside an unrelated quoted argument (e.g. an echo).
const SED_I_RE = /(^|[;&|\n]\s*)sed\s+-i(?!\s*'')(?=\s|$)/; // non-global: reused across calls via .test(), a /g flag here would make lastIndex leak between them
const SED_I_REPLACE_RE = /(^|[;&|\n]\s*)sed\s+-i(?!\s*'')(?=\s|$)/g; // same pattern, /g only for .replace() — safe there since replace() resets lastIndex itself; fixes every sed -i in a compound command, and the lookahead skips ones already `sed -i ''`

// -f/--follow (aws logs tail's only streaming flag; kubectl logs/docker logs/journalctl have it
// too) never terminates, so piping it through squirt would just buffer an unbounded stream forever
// — a hard block regardless of TALLY_NO_REWRITE, not a rewrite candidate like the rest of the
// log-dump rule. Token-bounded (whitespace on both sides) so it doesn't fire on a long option that
// merely contains "-f" (e.g. `--log-format`).
const FOLLOW_FLAG_RE = /(^|\s)(-f|--follow)(?=\s|$)/;

// $var:t / $var:h / $var:r / $var:e — zsh's csh-derived parameter-expansion modifiers
// (tail/head/root/ext), triggered by a BARE (unbraced) $name or $N immediately followed by a
// colon and one of these four lowercase letters. Verified empirically (zsh 5.9, non-interactive
// `zsh -c`, macOS): `ref=HEAD; echo git show $ref:tests/foo.py` → `git show HEADests/foo.py` —
// `:t` (tail) applied to "HEAD" (no "/", so tail-of-itself = "HEAD" unchanged), then "ests/foo.py"
// landed as literal text (from "tests" minus the consumed "t"). No trailing boundary needed after
// the letter — the modifier consumes exactly one letter and appends whatever follows literally,
// so `:tests/…`, `:temp`, `:hooks/…` etc. all corrupt, not just an exact `:t`/`:h` suffix.
// Braces are the real fix — `${ref}:tests/…` verified literal — NOT quoting: `"$ref:t"` still
// applies the modifier (verified), contradicting a "just quote it" framing. `$(cmd):t` (command
// substitution, as opposed to a bare parameter) is unaffected (verified) — only bare `$name`/`$N`
// triggers it, so the regex requires the char right after `$` to start a name/digit, not `(`/`{`.
// Scoped to t/h/r/e on purpose, not the full modifier alphabet (s/g/p/q/x/…, which mostly throw a
// loud "bad substitution" instead of silently corrupting, verified against a `src/`-style path) —
// those are self-announcing and don't need a guard; t/h/r/e are the silent-corruption set, and the
// only ones actually reported as a real burn.
const VAR_COLON_MODIFIER_RE = /\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+):[thre]/;

function looksLikeZshColonModifier(command: string): boolean {
  // double-quoted spans stay IN scope here (quoting doesn't neutralize this bug, verified above)
  // — only single-quoted spans and heredoc bodies are genuinely inert.
  return VAR_COLON_MODIFIER_RE.test(stripNonCodeSpans(command, true));
}

// files=$(git diff --name-only); git add $files — zsh does not word-split a bare $var/${var} the
// way bash's default does, so a multi-line/multi-path result collapses into ONE pathspec/argument
// instead of many (the confirmed burn behind this guard: "zsh doesn't word-split $revs — every
// multi-commit repo silently got zero results"). No safe rewrite — the fix (array vs. inline
// substitution vs. a loop) depends on intent a regex can't infer, so this blocks-with-hint like
// curl|sh rather than rewriting.
//
// Scoped tight on purpose: the Bash tool carries no state between calls, so a $var this hook can
// see either came from an assignment earlier in this SAME command string or is an env var — which
// makes "assigned from a list-producing command here + used bare later in the same string" close
// to complete coverage of the bug, not a loose guess. Two more narrowings, found while testing
// realistic false-positive shapes:
//   - the "list-producing" check runs against the LAST pipeline stage of the assignment's `$(...)`
//     body, not the body as a whole — `count=$(ls | wc -l)` is single-token output despite `ls`
//     appearing in it; matching anywhere would block one of the most common shapes for no reason.
//   - `echo`/`printf` are excluded on the consuming side — they print identically whether the
//     value split or not, so flagging `echo $files` is pure noise. Everything else (git add/rm,
//     cp, mv, rm, test/for) stays in scope via the assignment-side check, not a consumer allowlist.
const LIST_PRODUCER_RE = /^(git\s+diff\s+(--name-only|--name-status)\b|git\s+ls-files\b|git\s+rev-list\b|find\b|grep\s+-l\b)/;
// `[^)]*` doesn't handle a substitution body with its own parens — same regex-not-a-parser
// tradeoff as stripNonCodeSpans/bashLooksLikeLogDump elsewhere in this codebase.
const LIST_ASSIGN_RE = /(?:^|[;&\n]\s*)([A-Za-z_][A-Za-z0-9_]*)=\$\(([^)]*)\)/g;

function riskyListVars(command: string): string[] {
  const names: string[] = [];
  LIST_ASSIGN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LIST_ASSIGN_RE.exec(command))) {
    const lastStage = m[2].split('|').pop()?.trim() ?? '';
    if (LIST_PRODUCER_RE.test(lastStage)) names.push(m[1]);
  }
  return names;
}

function looksLikeZshWordSplit(command: string): boolean {
  const names = riskyListVars(command);
  if (names.length === 0) return false;
  const sanitized = stripNonCodeSpans(command); // both quote types stripped — quoting IS the fix here
  const alt = names.map(escapeRegExp).join('|');
  // (?!\[) excludes ${files[@]}/${files[1]} — the correct array-safe form, not the bug.
  const useRe = new RegExp(`\\$\\{?(?:${alt})(?!\\[)\\}?(?![A-Za-z0-9_])`, 'g');
  let m: RegExpExecArray | null;
  while ((m = useRe.exec(sanitized))) {
    const segStart =
      Math.max(sanitized.lastIndexOf(';', m.index), sanitized.lastIndexOf('&', m.index), sanitized.lastIndexOf('|', m.index), sanitized.lastIndexOf('\n', m.index)) + 1;
    const segHead = sanitized.slice(segStart, m.index).trim().split(/\s+/)[0] || '';
    if (/^(echo|printf)$/.test(segHead)) continue;
    return true;
  }
  return false;
}

function squirtOnPath(env: NodeJS.ProcessEnv): boolean {
  const sep = (env.platform || process.platform) === 'win32' ? ';' : ':';
  return (env.PATH || '').split(sep).some((dir) => dir && existsSync(join(dir, 'squirt')));
}

/** PreToolUse(Bash): rewrite the command when the fix is mechanical, block only when it isn't. */
function runPreBash(input: HookInput, env: NodeJS.ProcessEnv): HookResult {
  const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
  if (!command) return { exit: 0, stdout: '' };
  const noRewrite = env.TALLY_NO_REWRITE === '1';

  if (looksLikeCurlPipeShell(command)) {
    return block('tally: curl|wget piped straight into a shell — no safe rewrite; review the script, then run it yourself', env, 'pre-bash');
  }

  // both zsh checks ahead of log-dump: log-dump's `| squirt` rewrite would let a zsh-broken
  // command through as if it were fine.
  if (looksLikeZshColonModifier(command)) {
    return block(
      "tally: unbraced $var:t/:h/:r/:e — zsh applies it as a parameter modifier, not literal text (e.g. $ref:tests/… silently becomes '<tail of ref>ests/…'); wrap it in braces (${var}:…) or escape the colon ($var\\:…) — quoting alone does NOT fix this",
      env,
      'pre-bash',
    );
  }
  if (looksLikeZshWordSplit(command)) {
    return block(
      "tally: zsh doesn't word-split a bare $var/${var} the way bash's default does — a multi-line/multi-result assignment used unquoted here will collapse into ONE argument instead of many; use an array (x=(...); \"${x[@]}\") or a loop instead",
      env,
      'pre-bash',
    );
  }

  if (bashLooksLikeLogDump(command)) {
    if (FOLLOW_FLAG_RE.test(command)) {
      return block("tally: -f/--follow streams forever — squirt can't digest an unbounded tail; drop --follow (use --since/--start-time for a bounded window) or run it yourself", env, 'pre-bash');
    }
    if (!noRewrite && squirtOnPath(env) && !/[|><]/.test(command)) {
      return allow(input, { ...input.tool_input, command: `${command} | squirt` }, 'tally: piped through squirt to keep the raw dump out of context', env, 'pre-bash');
    }
    return block('tally: looks like a raw log dump — pipe through squirt (or head/tail/grep/wc)', env, 'pre-bash');
  }

  const platform = env.platform || process.platform;
  if (platform === 'darwin' && SED_I_RE.test(command)) {
    if (noRewrite) return block(`tally: macOS sed needs sed -i '' … (BSD sed, not GNU) — got: ${command}`, env, 'pre-bash');
    const rewritten = command.replace(SED_I_REPLACE_RE, "$1sed -i ''"); // $1 = the captured boundary prefix (start-of-string or ;/&/| + whitespace) — must survive the substitution
    return allow(input, { ...input.tool_input, command: rewritten }, "tally: macOS sed needs -i '' (BSD sed, not GNU)", env, 'pre-bash');
  }

  return { exit: 0, stdout: '' };
}

const READ_LIMIT_LINES = 300; // mirrors analyze.ts's read-full-file threshold
const COUNT_LINES_MAX_BYTES = 2 * 1024 * 1024; // well over 300 lines of any real source file — beyond this, don't load it just to guard against loading it

/** null = "well over the limit", without having read the file — avoids the guard itself
 *  paying the "read a huge file into memory" cost it exists to prevent the model from paying. */
function countLines(filePath: string): number | null {
  try {
    if (statSync(filePath).size > COUNT_LINES_MAX_BYTES) return null;
    return readFileSync(filePath, 'utf8').split('\n').length;
  } catch {
    return 0;
  }
}

/** PreToolUse(Read): cap an unbounded read of a long file instead of letting it all in. */
function runPreRead(input: HookInput, env: NodeJS.ProcessEnv): HookResult {
  const filePath = typeof input.tool_input?.file_path === 'string' ? input.tool_input.file_path : '';
  // only `limit` actually bounds the read — an `offset` with no `limit` reads unbounded to EOF,
  // which is exactly what this guard exists to catch, not a reason to skip it
  if (!filePath || input.tool_input?.limit) return { exit: 0, stdout: '' };
  const lines = countLines(filePath);
  if (lines !== null && lines <= READ_LIMIT_LINES) return { exit: 0, stdout: '' };
  const linesLabel = lines === null ? `over ${Math.round(COUNT_LINES_MAX_BYTES / 1024 / 1024)}MB` : `${lines} lines`;
  if (env.TALLY_NO_REWRITE === '1') {
    return block(`tally: ${filePath} is ${linesLabel} — use offset/limit instead of a full read`, env, 'pre-read');
  }
  return allow(input, { ...input.tool_input, limit: READ_LIMIT_LINES }, `tally: ${filePath} is ${linesLabel} — capped to the first ${READ_LIMIT_LINES} lines; pass limit/offset yourself for a different slice`, env, 'pre-read');
}

const SILENT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'TodoWrite']);
const LOOP_RE = /\bfor\s+\S+\s+in\b[\s\S]*?\bdo\b|\bwhile\b[\s\S]*?\bdo\b/;

/** PostToolUse (any tool): a nudge, never a block — the tool already ran. */
function runPostTool(input: HookInput): HookResult {
  if (input.tool_name && SILENT_TOOLS.has(input.tool_name)) return { exit: 0, stdout: '' }; // the harness echoes these diffs back regardless — nothing to trim
  const r = input.tool_response;
  const isImage = r != null && typeof r === 'object' && ((r as { type?: string }).type === 'image' || (r as { isImage?: boolean }).isImage === true);
  if (isImage) return { exit: 0, stdout: '' }; // never size/estimate base64 image payloads — the number is both huge and useless (nothing to trim)
  const size = JSON.stringify(input.tool_response ?? '').length;
  let threshold = BIG_RESULT_CHARS;
  if (input.tool_name === 'Bash' && LOOP_RE.test(String(input.tool_input?.command ?? ''))) threshold = 4 * BIG_RESULT_CHARS; // an explicit shell loop is already the trimmed shape
  if (size <= threshold) return { exit: 0, stdout: '' };
  const tok = fmt(estTokens(size));
  const additionalContext = input.tool_name === 'WebFetch'
    ? `tally: last result ~${tok} tok — that's the remote page's size; if you need it again, grep the saved tool-output file instead of re-fetching`
    : input.tool_name === 'Read' || input.tool_name === 'Bash'
      ? `tally: last result ~${tok} tok — trim next time (squirt / head / Read limit)`
      : `tally: last result ~${tok} tok entered context`;
  return {
    exit: 0,
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } }),
  };
}

const FEEDBACK_TOOLS = ['looksy', 'peep', 'squirt', 'tally', 'snuff', 'brief', 'pulse'];

function feedbackTools(env: NodeJS.ProcessEnv): string[] {
  return env.TALLY_TOOLS ? env.TALLY_TOOLS.split(',').map((t) => t.trim()).filter(Boolean) : FEEDBACK_TOOLS;
}

function gitHome(env: NodeJS.ProcessEnv): string {
  return env.TALLY_GIT || join(homedir(), 'git');
}

interface Marks {
  ts: number; // first-write time — the anchor stop-feedback compares FEEDBACK.md's mtime against, NOT the marks file's own (later-appended) mtime
  tools: string[];
  via?: Record<string, string>; // tool → the command (truncated) that first marked it — stop-feedback repeats this so the block says why
}

function marksPath(env: NodeJS.ProcessEnv, sessionId: string): string {
  return join(homeFor(env), 'marks', sessionId);
}

function loadMarks(path: string): Marks | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Marks;
  } catch {
    return null;
  }
}

/** PostToolUse(Bash): notes which of my own CLIs got used in a repo other than their own —
 *  the signal stop-feedback checks against ~/git/<tool>/FEEDBACK.md. Never blocks. */
function runPostBashMark(input: HookInput, env: NodeJS.ProcessEnv): HookResult {
  const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
  if (!command || !input.session_id) return { exit: 0, stdout: '' };
  const home = gitHome(env);
  // command-position match only (parse.ts usedToolsCertain), and only segments that CERTAINLY ran
  // given the overall exit was 0 (PostToolUse(Bash) never fires otherwise) — `pulse --brief` /
  // `cd ~/git/brief` are not usage, and a non-final `&&` chain may have been short-circuited.
  const matched = usedToolsCertain(command, feedbackTools(env)).filter(
    (tool) => !(input.cwd && isWithinDir(input.cwd, join(home, tool))), // used from inside its own repo (or a subdirectory of it) — not the dogfood signal this tracks
  );
  if (!matched.length) return { exit: 0, stdout: '' };
  const path = marksPath(env, input.session_id);
  const marks = loadMarks(path) ?? { ts: Date.now(), tools: [] };
  let changed = false;
  for (const t of matched) {
    if (!marks.tools.includes(t)) {
      marks.tools.push(t);
      marks.via = { ...(marks.via ?? {}), [t]: command.replace(/\s+/g, ' ').trim().slice(0, 60) };
      changed = true;
    }
  }
  if (changed) {
    try {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, JSON.stringify(marks));
    } catch {
      // best-effort — a state-write failure must never affect the tool call that triggered it
    }
  }
  return { exit: 0, stdout: '' };
}

/** Stop: blocks (exit 2) when a tool marked this session was used but its FEEDBACK.md wasn't
 *  touched since. Re-checks live each time — no need to clear marks once FEEDBACK.md catches up. */
function runStopFeedback(input: HookInput, env: NodeJS.ProcessEnv): HookResult {
  if (input.stop_hook_active || !input.session_id) return { exit: 0, stdout: '' }; // never re-block a Stop hook's own re-invocation
  const marks = loadMarks(marksPath(env, input.session_id));
  if (!marks || !marks.tools.length) return { exit: 0, stdout: '' };
  const home = gitHome(env);
  const untouched = marks.tools.filter((tool) => {
    try {
      return statSync(join(home, tool, 'FEEDBACK.md')).mtimeMs < marks.ts;
    } catch {
      return true; // no FEEDBACK.md at all — definitely untouched
    }
  });
  if (!untouched.length) return { exit: 0, stdout: '' };
  const label = (t: string) => (marks.via?.[t] ? `${t} (marked from: \`${marks.via[t]}\`)` : t);
  const message = untouched.length === 1
    ? `FEEDBACK.md not updated for: ${label(untouched[0])} — append a dated section to ${join(home, untouched[0], 'FEEDBACK.md')}`
    : `FEEDBACK.md not updated for: ${untouched.map(label).join(', ')} — append a dated section to each ~/git/<tool>/FEEDBACK.md`;
  return { exit: 2, stdout: '', message };
}

const HOOK_NAMES = ['ctx-guard', 'pre-bash', 'pre-read', 'post-tool', 'post-bash-mark', 'stop-feedback'];

export function runHook(name: string, input: HookInput, env: NodeJS.ProcessEnv = process.env): HookResult {
  if (name === 'ctx-guard') return runCtxGuard(input, env);
  if (name === 'pre-bash') return runPreBash(input, env);
  if (name === 'pre-read') return runPreRead(input, env);
  if (name === 'post-tool') return runPostTool(input);
  if (name === 'post-bash-mark') return runPostBashMark(input, env);
  if (name === 'stop-feedback') return runStopFeedback(input, env);
  // exit 0 either way — a hook must never block on its own misconfiguration — but a stderr
  // line means a typo'd settings.json entry (e.g. "pre-bahs") doesn't silently do nothing forever
  return { exit: 0, stdout: '', message: `tally: unknown hook "${name}" (expected one of: ${HOOK_NAMES.join(', ')}) — this call did nothing` };
}

const HOOK_CMD_PREFIX = 'command -v tally >/dev/null 2>&1 || exit 0; tally hook ';

/** wired by `tally hooks --install`. `matcher: undefined` = a matcher-less group (UserPromptSubmit,
 *  Stop). ctx-guard rides both PreToolUse `.*` and UserPromptSubmit per the Phase 2.0 decision to
 *  install it alongside pre-bash/pre-read/post-tool here rather than via a second mechanism.
 *  stop-feedback is the one entry here that can actually block (exit 2) — everything else either
 *  rewrites or nags. */
const HOOK_WIRING: { event: string; matcher?: string; hookName: string }[] = [
  { event: 'PreToolUse', matcher: 'Bash', hookName: 'pre-bash' },
  { event: 'PreToolUse', matcher: 'Read', hookName: 'pre-read' },
  { event: 'PreToolUse', matcher: '.*', hookName: 'ctx-guard' },
  { event: 'PostToolUse', matcher: '.*', hookName: 'post-tool' },
  { event: 'PostToolUse', matcher: 'Bash', hookName: 'post-bash-mark' },
  { event: 'UserPromptSubmit', hookName: 'ctx-guard' },
  { event: 'Stop', hookName: 'stop-feedback' },
];

interface HookGroup {
  matcher?: string;
  hooks: { type: string; command: string }[];
}

interface Settings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

/** idempotent: an existing group with the same matcher gets a new `hooks[]` entry only if
 *  no command in it already runs this hook name; unrelated existing hooks are left untouched. */
function ensureWired(groups: HookGroup[], matcher: string | undefined, hookName: string): boolean {
  let group = groups.find((g) => (g.matcher ?? undefined) === matcher);
  if (!group) {
    group = matcher !== undefined ? { matcher, hooks: [] } : { hooks: [] };
    groups.push(group);
  }
  if (!group.hooks) group.hooks = [];
  const needle = `tally hook ${hookName}`;
  if (group.hooks.some((h) => typeof h.command === 'string' && h.command.includes(needle))) return false;
  group.hooks.push({ type: 'command', command: `${HOOK_CMD_PREFIX}${hookName}` });
  return true;
}

/** merges tally's hooks into a `.claude/settings.json` text (or `undefined` for a fresh file).
 *  Idempotent — running it twice on its own output changes nothing. */
export function mergeHooks(settingsText?: string): { text: string; changed: boolean } {
  const settings: Settings = settingsText ? JSON.parse(settingsText) : {};
  const changed = mergeInto(settings);
  return { text: serializeSettings(settings), changed };
}

function serializeSettings(settings: Settings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function mergeInto(settings: Settings): boolean {
  if (!settings.hooks) settings.hooks = {};
  let changed = false;
  for (const w of HOOK_WIRING) {
    if (!Array.isArray(settings.hooks[w.event])) settings.hooks[w.event] = []; // truthy-but-malformed (e.g. hand-edited to `{}`) gets replaced, not trusted
    if (ensureWired(settings.hooks[w.event], w.matcher, w.hookName)) changed = true;
  }
  return changed;
}

// hand-written predecessors of `tally hook pre-bash` — the inline curl|sh one-liner (shape of the
// real one: `grep -qE '(curl|wget).*\\|.*sh'` … exit 2) and the sed-guard.sh script. `pre-bash` covers
// both, so `--install` absorbs them (removes them, after a backup). squirt-guard.sh is squirt's — never touched.
const LEGACY_CURL_SH_RE = /curl[^\n]*\\?\|[^\n]*\b(sudo\s+)?(ba)?sh\b/;
const LEGACY_SED_GUARD_RE = /\/hooks\/sed-guard\.sh(\s|$)/;

/** removes hand-written PreToolUse(Bash) hooks that `pre-bash` now covers; returns what was
 *  absorbed (origin labels, for the printed `absorbed: …` lines). Only these two shapes — anything
 *  else stays. */
export function absorbLegacy(settings: Settings, hooksDir: string): string[] {
  const absorbed: string[] = [];
  const groups = settings.hooks?.PreToolUse;
  if (!Array.isArray(groups)) return absorbed;
  for (const g of groups) {
    if (!Array.isArray(g.hooks)) continue;
    g.hooks = g.hooks.filter((h) => {
      const command = typeof h.command === 'string' ? h.command : '';
      const origin = hookOrigin(command, hooksDir);
      if (origin === 'tally' || origin === 'squirt' || /squirt/.test(command)) return true;
      const legacy = (origin === 'inline' && LEGACY_CURL_SH_RE.test(command)) || LEGACY_SED_GUARD_RE.test(command);
      if (!legacy) return true;
      absorbed.push(origin === 'inline' ? `inline curl|sh guard (${cap(command, 40)})` : origin);
      return false;
    });
  }
  return absorbed;
}

export interface HookRow {
  event: string;
  matcher?: string;
  command: string;
  origin: string; // 'tally' | 'squirt' | a path under hooksDir | 'inline'
}

/** priority: a tally-owned command always wins; then a script living under `hooksDir` (its
 *  path IS the origin — more specific than the generic 'squirt' label); then a bare reference
 *  to the squirt CLI itself (`squirt init`, or a squirt-guard command not living in hooksDir);
 *  anything else was hand-written straight into settings.json. */
function hookOrigin(command: string, hooksDir: string): string {
  if (command.includes('tally hook')) return 'tally';
  // settings.json commands are written with a literal `~`, not an expanded absolute path —
  // match both forms so a real `~/.claude/hooks/x.sh` command still resolves to hooksDir's origin
  const variants = hooksDir.startsWith(homedir()) ? [hooksDir, `~${hooksDir.slice(homedir().length)}`] : [hooksDir];
  for (const dir of variants) {
    const dirMatch = new RegExp(`${escapeRegExp(dir)}\\S*`).exec(command);
    if (dirMatch) return dirMatch[0];
  }
  if (/squirt-guard|squirt init/.test(command)) return 'squirt';
  return 'inline';
}

/** flattens every `hooks.<event>[].hooks[]` command in a `.claude/settings.json` text into rows,
 *  tagged with who owns each one — the visibility needed to hand-remove what tally's own hooks
 *  now cover (tally never deletes a hook it did not write). */
export function listHooks(settingsText: string | undefined, hooksDir: string): HookRow[] {
  const settings: Settings = settingsText ? JSON.parse(settingsText) : {};
  const rows: HookRow[] = [];
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      for (const h of g.hooks ?? []) {
        if (typeof h.command !== 'string') continue;
        rows.push({ event, matcher: g.matcher, command: h.command, origin: hookOrigin(h.command, hooksDir) });
      }
    }
  }
  return rows;
}

/** a short, human-readable label for a duplicate-guard line: the tally hook name (not the whole
 *  `command -v tally … || …` wrapper) for a 'tally' row, or the script basename for a hooksDir-path
 *  row — the origin as-is for anything else ('squirt', or a bare 'inline' that slipped through). */
function duplicateLabel(row: HookRow): string {
  if (row.origin === 'tally') return /tally hook (\S+)/.exec(row.command)?.[1] ?? 'tally';
  const parts = row.origin.split('/');
  return parts[parts.length - 1] || row.origin;
}

/** flags hooks wired on the same event+matcher that are likely doing the same job — e.g. a
 *  hand-written `squirt-guard.sh` left in place alongside tally's own `pre-bash` rewriter, both
 *  rewriting log-dump commands to `| squirt`. Minimal heuristic, informational only (never blocks
 *  anything): ≥2 DISTINCT non-'inline' origins sharing an event+matcher is enough to flag — no
 *  attempt to compare what the commands actually do, since a human already has to look either way. */
export function findDuplicateHooks(rows: HookRow[]): string[] {
  const groups = new Map<string, HookRow[]>();
  for (const r of rows) {
    const key = `${r.event}\0${r.matcher ?? ''}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  const lines: string[] = [];
  for (const [key, group] of groups) {
    const nonInline = group.filter((r) => r.origin !== 'inline');
    if (new Set(nonInline.map((r) => r.origin)).size < 2) continue;
    const [event, matcher] = key.split('\0');
    lines.push(`⚠ duplicate: ${nonInline.map(duplicateLabel).join(' ~ ')} (same job — ${event}${matcher ? `/${matcher}` : ''})`);
  }
  return lines;
}

export function renderHooksList(rows: HookRow[]): string {
  if (!rows.length) return 'no hooks configured';
  const L = [`${pad('event', 17)}${pad('matcher', 9)}${pad('command', 50)}origin`];
  // tally's own entries show as `tally hook <name>` — the `command -v tally … ||` guard prefix is noise here
  for (const r of rows) L.push(`${pad(r.event, 17)}${pad(r.matcher ?? '-', 9)}${pad(cap(r.command.replace(HOOK_CMD_PREFIX, 'tally hook '), 48), 50)}${r.origin}`);
  L.push(...findDuplicateHooks(rows));
  return L.join('\n');
}

export interface HooksCmdOpts {
  install?: boolean;
  print?: boolean;
  list?: boolean;
  global?: boolean;
  root?: string; // override for tests — never defaults to a real home dir in a test
  hooksDir?: string; // override for tests — where squirt-guard.sh/sed-guard.sh live (default ~/.claude/hooks)
  target?: string; // --target <config-dir>: the dir IS the .claude-equivalent — <target>/settings.json, <target>/hooks
  keepLegacy?: boolean; // --keep-legacy: don't absorb the hand-written curl|sh / sed-guard.sh predecessors
  runSquirtInit?: () => string; // injectable for tests — default spawns `squirt init --claude [--global]`
  now?: Date; // backup-suffix date, injectable for tests
}

export interface HooksCmdResult {
  exit: number;
  stdout: string;
  message: string;
}

function defaultSquirtInit(global: boolean | undefined, env: NodeJS.ProcessEnv): string {
  const args = ['init', '--claude', ...(global ? ['--global'] : [])];
  try {
    const out = execFileSync('squirt', args, { env, cwd: process.cwd(), timeout: 15_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return `squirt init: ${out.trim().split('\n').pop() || 'ok'}`;
  } catch (e) {
    return `squirt init --claude${global ? ' --global' : ''} failed: ${(e as Error).message.split('\n')[0]} — run it yourself`;
  }
}

/** `tally hooks --install [--global] [--keep-legacy] | --print | --list`. Targets `<root>/.claude/settings.json`,
 *  root = cwd, or `~` with --global. `--print`/`--list` never write. `--install` is the single owner:
 *  it wires tally's 7 entries, absorbs the hand-written curl|sh / sed-guard.sh predecessors `pre-bash`
 *  covers (backup first), delegates the squirt guard to `squirt init --claude` when squirt's on PATH
 *  and no squirt hook is wired yet, and writes nothing when the result is byte-identical. */
export async function cmdHooks(opts: HooksCmdOpts, env: NodeJS.ProcessEnv = process.env): Promise<HooksCmdResult> {
  const root = opts.root ?? (opts.global ? homedir() : process.cwd());
  const settingsPath = opts.target ? join(opts.target, 'settings.json') : join(root, '.claude', 'settings.json');
  const hooksDir = opts.hooksDir ?? join(opts.target ?? join(root, '.claude'), 'hooks');
  let existing: string | undefined;
  try {
    existing = readFileSync(settingsPath, 'utf8');
  } catch {
    // no settings.json yet — mergeHooks starts fresh
  }
  if (opts.list) {
    if (existing === undefined && opts.target) return { exit: 0, stdout: `no hooks at ${settingsPath}`, message: '' };
    if (existing === undefined && !opts.global) return { exit: 0, stdout: `no local hooks (${root}) — try --global`, message: '' };
    return { exit: 0, stdout: renderHooksList(listHooks(existing, hooksDir)), message: '' };
  }
  if (opts.print) return { exit: 0, stdout: mergeHooks(existing).text, message: '' };
  if (opts.install) {
    const settings: Settings = existing ? JSON.parse(existing) : {};
    const absorbed = opts.keepLegacy ? [] : absorbLegacy(settings, hooksDir);
    const wired = mergeInto(settings);
    const text = serializeSettings(settings);
    const notes: string[] = [];
    // no semantic change → don't touch the file at all (a hand-formatted 4-space file stays byte-identical, no backup)
    if ((!wired && !absorbed.length) || text === existing) {
      notes.push(`${settingsPath} already has tally's hooks — nothing to change`);
    } else {
      mkdirSync(opts.target ?? join(root, '.claude'), { recursive: true });
      if (existing !== undefined) {
        const d = opts.now ?? new Date();
        const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
        writeFileSync(`${settingsPath}.bak-tally-install-${stamp}`, existing);
      }
      writeFileSync(settingsPath, text);
      for (const a of absorbed) notes.push(`absorbed: ${a}`);
      if (wired) notes.push(`wired ${HOOK_WIRING.length} hooks into ${settingsPath}`);
    }
    if (squirtOnPath(env)) {
      const hasSquirt = /squirt-guard|squirt init|squirt hook/.test(text);
      if (hasSquirt) notes.push('squirt guard managed by squirt init — left alone');
      else notes.push((opts.runSquirtInit ?? (() => defaultSquirtInit(opts.global, env)))());
    }
    return { exit: 0, stdout: '', message: notes.join('\n') };
  }
  return { exit: 2, stdout: '', message: 'tally hooks: pass --install, --print, --list, or --suggest' };
}
