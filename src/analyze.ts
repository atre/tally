import { addUsage, emptyUsage, escapeRegExp, estTokens } from './parse.js';
import { fmt } from './render.js';
import { costOf, type PricingRate } from './pricing.js';
import type { CtxCross, Finding, ProjectRow, Report, Scan, Session, ToolCall, ToolRow } from './types.js';

export const BIG_RESULT_CHARS = 8_000; // ~2k tokens
export const HUGE_RESULT_CHARS = 40_000; // ~10k tokens
export const DEFAULT_CTX_LIMIT = 150_000;

interface CtxStats {
  peak: number;
  burned: number;
  avg: number;
  crossLimit: CtxCross | null;
  cross2x: CtxCross | null;
}

/** over the main-loop ctx series (sidechain turns are excluded at scan time) */
export function ctxStats(s: Session, limit: number): CtxStats {
  let peak = 0;
  let burned = 0;
  let sum = 0;
  let crossLimit: CtxCross | null = null;
  let cross2x: CtxCross | null = null;
  for (let i = 0; i < s.ctx.length; i++) {
    const c = s.ctx[i];
    if (c.cacheRead > peak) peak = c.cacheRead;
    burned += Math.max(0, c.cacheRead - limit);
    sum += c.cacheRead;
    if (!crossLimit && c.cacheRead >= limit) crossLimit = { turn: i + 1, ts: c.ts };
    if (!cross2x && c.cacheRead >= 2 * limit) cross2x = { turn: i + 1, ts: c.ts };
  }
  return { peak, burned, avg: s.ctx.length ? Math.round(sum / s.ctx.length) : 0, crossLimit, cross2x };
}

function short(s: unknown, n = 90): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export function describe(c: ToolCall): string {
  const i = c.input;
  if (c.name === 'Bash') return `Bash: ${short(i.command)}`;
  if (c.name === 'Read') return `Read: ${short(i.file_path)}${i.limit ? ` (limit ${i.limit})` : ''}`;
  if (c.name === 'Grep') return `Grep: ${short(i.pattern)} in ${short(i.path ?? '.')}`;
  if (c.name === 'Glob') return `Glob: ${short(i.pattern)}`;
  if (c.name === 'Edit' || c.name === 'Write') return `${c.name}: ${short(i.file_path)}`;
  if (c.name === 'NotebookEdit') return `NotebookEdit: ${short(i.notebook_path)}`;
  if (c.name === 'WebFetch') return `WebFetch: ${short(i.url)}`;
  if (c.name === 'WebSearch') return `WebSearch: ${short(i.query)}`;
  if (c.name === 'Agent') return `Agent(${short(i.subagent_type ?? 'general')}): ${short(i.description)}`;
  return `${c.name}: ${short(JSON.stringify(i), 80)}`;
}

const SUBCMD = new Set(['git', 'npm', 'npx', 'pnpm', 'yarn', 'node', 'kubectl', 'docker', 'gh', 'aws', 'helm', 'terraform', 'tofu', 'make', 'cargo', 'go', 'python', 'python3', 'pip', 'brew']);

/** "Bash git push" / "Read" — the unit errors repeat at; strips cd/env prefixes and pipes */
export function errorKey(c: ToolCall): string {
  if (c.name !== 'Bash' || typeof c.input.command !== 'string') return c.name;
  let cmd = c.input.command.trim();
  cmd = cmd.replace(/^((cd\s+\S+|sleep\s+\S+)\s*(&&|;)\s*)+/, '').replace(/^(\w+=\S*\s+)+/, '').replace(/^(sudo|time|env)\s+/, '');
  const words = cmd.split(/\s+/).filter(Boolean);
  if (!words.length) return 'Bash';
  const head = words[0].replace(/^.*\//, '');
  const sub = words[1] && !words[1].startsWith('-') && SUBCMD.has(head) ? ` ${words[1]}` : '';
  return `Bash ${head}${sub}`;
}

/** top erroring commands: "Bash git push ×12 ~3k tok · e.g. git push origin main" */
function errorSamples(calls: ToolCall[], top: number): string[] {
  const g = new Map<string, ToolCall[]>();
  for (const c of calls) {
    const k = errorKey(c);
    const arr = g.get(k);
    if (arr) arr.push(c);
    else g.set(k, [c]);
  }
  return [...g.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, top)
    .map(([k, arr]) => {
      const tok = arr.reduce((n, c) => n + estTokens(c.resultChars), 0);
      const eg = arr[0].name === 'Bash' ? ` · e.g. ${short(arr[0].input.command, 60)}` : '';
      return `${k} ×${arr.length} ~${tok.toLocaleString()} tok${eg}`;
    });
}

// description only, deliberately no regex literal here — hooks.ts owns the real pattern, and a
// copy here would silently drift every time that one gets tightened (it already has, twice)
const KNOWN_GUARDS: Record<string, string> = {
  'Bash sed': 'already shipped — pre-bash rewrites this via updatedInput, no action needed',
};

/** top 3 error-prone command heads → a guard to consider, print-only (`tally hooks --suggest`). */
export function suggestGuards(r: Report): string[] {
  return r.byHead
    .filter((h) => h.errors > 0)
    .sort((a, b) => b.errors - a.errors)
    .slice(0, 3)
    // the guard sees the bash command itself, not `Bash …` — strip the tool name from the head before it becomes a regex
    .map((h) => `${h.key} ×${h.errors} → guard: ${KNOWN_GUARDS[h.key] ?? `/^${h.key.replace(/^\S+\s+/, '')}\\b/ — no rule yet, add one to pre-bash if this keeps recurring`}`);
}

/** Drops heredoc bodies (`<<'EOF' … EOF`) and single/double-quoted string contents before the
 *  log-dump test runs — a `git commit -m` describing "aws logs tail" as prose inside a heredoc
 *  or a quoted message must not read as a real invocation (same disease as the `usedTools`
 *  quote-unaware split: matching a raw shell string with no idea what's code vs. data). Real
 *  log-dump commands are essentially never themselves wrapped whole in a heredoc or single-quoted
 *  string, so this trades a rare false negative (`bash -c "kubectl logs pod"`) for the common
 *  false positive (a commit message that happens to mention the phrase). */
function stripNonCodeSpans(cmd: string): string {
  let heredocFree = '';
  let i = 0;
  const heredocStart = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
  let m: RegExpExecArray | null;
  while (i <= cmd.length && (heredocStart.lastIndex = i, (m = heredocStart.exec(cmd)))) {
    heredocFree += cmd.slice(i, heredocStart.lastIndex);
    const delim = m[2];
    const termRe = new RegExp(`^[ \\t]*${escapeRegExp(delim)}[ \\t]*$`, 'm');
    const rest = cmd.slice(heredocStart.lastIndex);
    const termMatch = termRe.exec(rest);
    i = termMatch ? heredocStart.lastIndex + termMatch.index + termMatch[0].length : cmd.length;
  }
  heredocFree += cmd.slice(i);

  let result = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < heredocFree.length; i++) {
    const ch = heredocFree[i];
    // Same backslash-escape as splitCommandSegments: `\"` inside a double-quoted string is a
    // literal quote, not the string's end — without this, an escaped quote flips `quote` off
    // early and everything after (including the closing quote) leaks back into `result`.
    if (ch === '\\' && quote !== "'" && i + 1 < heredocFree.length) {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    result += ch;
  }
  return result;
}

// aws logs tail/get-log-events (CloudWatch) and gh run view --log (Actions) dump logs
// the same way k3s sessions dump kubectl logs; `gh run view … --log` matches --log wherever
// it lands in the arg list ((?:\S+\s+)*), since real usage puts it either right after `view` or
// after the run id.
export function bashLooksLikeLogDump(cmd: string): boolean {
  const sanitized = stripNonCodeSpans(cmd);
  return (
    /\b(kubectl\s+logs|docker\s+logs|journalctl|aws\s+logs\s+(tail|get-log-events)|gh\s+run\s+view\s+(?:\S+\s+)*--log\b|tail\s+-n?\s*\d{3,}|cat\s+\S+\.log)\b/.test(
      sanitized,
    ) && !/\|\s*(squirt|head|tail|grep|wc)\b/.test(sanitized)
  );
}

export interface AnalyzeOpts {
  pricing?: Record<string, PricingRate>;
}

export function analyze(scan: Scan, since: number, until: number, top = 5, ctxLimit = DEFAULT_CTX_LIMIT, opts: AnalyzeOpts = {}): Report {
  const usage = emptyUsage();
  const byProject = new Map<string, ProjectRow>();
  const byDay = new Map<string, { day: string; sessions: Set<string>; turns: number; usage: ReturnType<typeof emptyUsage> }>();
  const byModel = new Map<string, { model: string; turns: number; usage: ReturnType<typeof emptyUsage> }>();
  for (const t of scan.turns) {
    addUsage(usage, t.usage);
    let p = byProject.get(t.project);
    if (!p) {
      p = { project: t.project, sessions: 0, turns: 0, usage: emptyUsage(), toolResultTokens: 0 };
      byProject.set(t.project, p);
    }
    p.turns++;
    addUsage(p.usage, t.usage);
    let m = byModel.get(t.model);
    if (!m) {
      m = { model: t.model, turns: 0, usage: emptyUsage() };
      byModel.set(t.model, m);
    }
    m.turns++;
    addUsage(m.usage, t.usage);
    const day = new Date(t.timestamp).toISOString().slice(0, 10);
    let d = byDay.get(day);
    if (!d) {
      d = { day, sessions: new Set(), turns: 0, usage: emptyUsage() };
      byDay.set(day, d);
    }
    d.sessions.add(t.sessionId);
    d.turns++;
    addUsage(d.usage, t.usage);
  }
  for (const s of scan.sessions.values()) {
    const p = byProject.get(s.project);
    if (p) p.sessions++;
  }

  const byTool = new Map<string, ToolRow>();
  for (const c of scan.calls) {
    let r = byTool.get(c.name);
    if (!r) {
      r = { name: c.name, calls: 0, resultTokens: 0, errors: 0 };
      byTool.set(c.name, r);
    }
    r.calls++;
    r.resultTokens += estTokens(c.resultChars);
    if (c.isError) r.errors++;
    const p = byProject.get(c.project);
    if (p) p.toolResultTokens += estTokens(c.resultChars);
  }

  const findings: Finding[] = [];
  const claimed = new Set<string>();
  /** each call lands in the first bucket that claims it, so findings don't double-count */
  const push = (key: string, title: string, hint: string, candidates: ToolCall[], samplesOf?: (calls: ToolCall[]) => string[]) => {
    const calls = candidates.filter((c) => !claimed.has(c.id));
    if (!calls.length) return;
    for (const c of calls) claimed.add(c.id);
    const sorted = [...calls].sort((a, b) => b.resultChars - a.resultChars);
    findings.push({
      key,
      title,
      count: calls.length,
      tokens: calls.reduce((n, c) => n + estTokens(c.resultChars), 0),
      hint,
      samples: samplesOf ? samplesOf(calls) : sorted.slice(0, top).map((c) => `${describe(c)} → ~${estTokens(c.resultChars).toLocaleString()} tok`),
    });
  };

  const main = scan.calls.filter((c) => !c.isSidechain);

  // which of my own CLIs (or Read/Grep/etc.) is verbose to the model — same grouping key as
  // the errors finding's "top erroring commands", but over every main-loop call, not just errors
  const byHeadMap = new Map<string, { key: string; calls: number; resultTokens: number; errors: number }>();
  for (const c of main) {
    const k = errorKey(c);
    let h = byHeadMap.get(k);
    if (!h) {
      h = { key: k, calls: 0, resultTokens: 0, errors: 0 };
      byHeadMap.set(k, h);
    }
    h.calls++;
    h.resultTokens += estTokens(c.resultChars);
    if (c.isError) h.errors++;
  }
  const byHead = [...byHeadMap.values()].sort((a, b) => b.resultTokens - a.resultTokens);

  // retries: identical tool input repeated within the same session
  const seen = new Map<string, ToolCall[]>();
  for (const c of main) {
    const k = c.sessionId + '|' + c.inputKey;
    const arr = seen.get(k);
    if (arr) arr.push(c);
    else seen.set(k, [c]);
  }
  const retried: ToolCall[] = [];
  for (const arr of seen.values()) if (arr.length > 1) retried.push(...arr.slice(1));
  push('retries', 'Identical tool call repeated in a session', 'the first result was lost or ignored — cache it, or trust it', retried);
  push('denials', 'Permission denials / interruptions', 'ask before risky commands, or allow-list the safe ones', main.filter((c) => c.isDenied), (calls) => errorSamples(calls, top));
  push('errors', 'Tool errors', 'each error = a wasted round-trip; the top command is where to fix a flag, path, or permission', main.filter((c) => c.isError), (calls) => errorSamples(calls, top));
  push('log-dump', 'Raw log dumps in Bash', 'pipe through squirt', main.filter((c) => c.name === 'Bash' && typeof c.input.command === 'string' && bashLooksLikeLogDump(c.input.command)));
  push('read-full-file', 'Read of long files without limit', 'use limit/offset, or Grep for the symbol first', main.filter((c) => c.name === 'Read' && !c.input.limit && c.resultLines > 300));
  push('huge-results', 'Huge tool results (>~10k tokens)', 'pipe through squirt / head / grep, or Read with offset+limit', main.filter((c) => c.resultChars >= HUGE_RESULT_CHARS));
  push('big-results', 'Big tool results (~2k–10k tokens)', 'trim before it enters context', main.filter((c) => c.resultChars >= BIG_RESULT_CHARS && c.resultChars < HUGE_RESULT_CHARS));
  push('subagents', 'Subagent spawns (Agent tool)', 'each re-reads the repo; a repo map / CLAUDE.md pointer is cheaper', main.filter((c) => c.name === 'Agent'));

  const stats = new Map<string, CtxStats>();
  for (const s of scan.sessions.values()) stats.set(s.id, ctxStats(s, ctxLimit));

  const heaviest = [...scan.sessions.values()]
    .map((s) => {
      const st = stats.get(s.id)!;
      return {
        id: s.id.slice(0, 8),
        project: s.project,
        turns: s.turns,
        avgContext: st.avg,
        output: s.usage.output,
        cacheRead: s.usage.cacheRead,
        peakCtx: st.peak,
        crossLimit: st.crossLimit,
        cross2x: st.cross2x,
        burnedAbove: st.burned,
        ctxSeries: s.ctx.map((c) => c.cacheRead),
      };
    })
    .sort((a, b) => b.cacheRead - a.cacheRead);

  findings.sort((a, b) => b.tokens - a.tokens);

  // hook output (SessionStart context injections, PreToolUse/PostToolUse additionalContext, …)
  // goes LAST regardless of token sort — it's fixed overhead you set up yourself, not a leak to
  // chase like the tool buckets above; main-loop only, same convention as everything else here
  const byHook = new Map<string, { hook: string; count: number; tokens: number }>();
  for (const h of scan.hookOutputs) {
    if (h.isSidechain) continue;
    let g = byHook.get(h.hook);
    if (!g) {
      g = { hook: h.hook, count: 0, tokens: 0 };
      byHook.set(h.hook, g);
    }
    g.count++;
    g.tokens += estTokens(h.chars);
  }
  if (byHook.size) {
    const rows = [...byHook.values()].sort((a, b) => b.tokens - a.tokens);
    findings.push({
      key: 'hook-output',
      title: 'Hook output injected into context',
      count: rows.reduce((n, r) => n + r.count, 0),
      tokens: rows.reduce((n, r) => n + r.tokens, 0),
      hint: 'SessionStart/hook printers add up on top of the digest itself — keep each one to a budget',
      samples: rows.slice(0, top).map((r) => `${r.hook} ×${r.count} ~${fmt(r.tokens)} tok`),
    });
  }

  // long-context goes FIRST regardless of token sort — context × turns is the real bill,
  // the tool buckets are only what fattens it
  const longCtx = [...scan.sessions.values()]
    .map((s) => ({ s, st: stats.get(s.id)! }))
    .filter((x) => x.st.avg > ctxLimit)
    .sort((a, b) => b.st.burned - a.st.burned);
  if (longCtx.length) {
    findings.unshift({
      key: 'long-context',
      title: `Long-context sessions (avg ctx > ${fmt(ctxLimit)})`,
      count: longCtx.length,
      tokens: longCtx.reduce((n, x) => n + x.st.burned, 0),
      hint: '/compact earlier or start a new session',
      samples: longCtx.slice(0, top).map((x) => {
        const at = x.st.crossLimit ? x.st.crossLimit.turn : 1;
        return `${x.s.id.slice(0, 8)} ${x.s.project}: crossed ${fmt(ctxLimit)} at turn ${at}/${x.s.ctx.length}, peak ${fmt(x.st.peak)}, ~${fmt(x.st.burned)} burned above ${fmt(ctxLimit)} → /compact or new session at turn ${at}`;
      }),
    });
  }

  return {
    since,
    until,
    files: scan.files,
    sessions: scan.sessions.size,
    turns: scan.turns.length,
    ctxLimit,
    usage,
    byProject: [...byProject.values()].sort((a, b) => (b.usage.output + b.usage.cacheCreate + b.usage.input) - (a.usage.output + a.usage.cacheCreate + a.usage.input)),
    byDay: [...byDay.values()].map((d) => ({ day: d.day, sessions: d.sessions.size, turns: d.turns, usage: d.usage })).sort((a, b) => a.day.localeCompare(b.day)),
    byTool: [...byTool.values()].sort((a, b) => b.resultTokens - a.resultTokens),
    byHead,
    byModel: [...byModel.values()]
      .map((m) => {
        const rate = opts.pricing?.[m.model];
        return rate ? { ...m, estCost: costOf(m.usage, rate) } : m;
      })
      .sort((a, b) => b.turns - a.turns),
    findings,
    heaviest,
  };
}
