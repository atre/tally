import type { Report, Usage } from './types.js';
import type { PoolpoolRow } from './poolpool.js';
import type { BuiltinRow, GuardRow, SkillRow, ToolUsageRow } from './tools.js';
import type { FatFileRow, ResidentRow } from './files.js';

export function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000) return Math.round(n / 1000) + 'k';
  if (n >= 1_000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

/** "billable-ish" tokens: everything except cache reads (which are cheap and dominated by context size). */
export function fresh(u: Usage): number {
  return u.input + u.output + u.cacheCreate;
}

export function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
/** truncate so long names (mcp__foo__bar_tool) can't break column alignment */
export function cap(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function rpad(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}
/** mcp__server__tool names differ at the END — keep the suffix, truncate the left. */
export function capName(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.startsWith('mcp__') ? '…' + s.slice(s.length - (n - 1)) : cap(s, n);
}

/** `7d`, or `all` when the window is unbounded (`--since all` → since 0) — never `20682d`. */
function windowLabel(r: Report): string {
  if (r.since === 0) return 'all';
  return `${Math.max(1, Math.round((r.until - r.since) / 86_400_000))}d`;
}

export function renderText(r: Report, opts: { top: number; by?: 'session' | 'day' | 'repo'; poolpool?: PoolpoolRow[]; cost?: boolean }): string {
  const L: string[] = [];
  L.push(`tally — ${windowLabel(r)} window · ${r.files} transcripts · ${r.sessionCount} sessions · ${r.turns.toLocaleString()} API turns`);
  L.push(`tokens  out ${fmt(r.usage.output)} · cache-write ${fmt(r.usage.cacheCreate)} · cache-read ${fmt(r.usage.cacheRead)} · uncached-in ${fmt(r.usage.input)}`);
  const perTurn = r.turns ? Math.round(r.usage.cacheRead / r.turns) : 0;
  L.push(`avg context per turn ~${fmt(perTurn)} tok · fresh tokens/turn ~${fmt(r.turns ? Math.round(fresh(r.usage) / r.turns) : 0)}`);
  L.push('');

  if (opts.by === 'day') {
    L.push(pad(`by day (${windowLabel(r)})`, 28) + 'sess  turns   out    cache-w  cache-r');
    for (const d of r.byDay) {
      L.push(`  ${pad(d.day, 26)}${rpad(String(d.sessions), 4)}${rpad(String(d.turns), 7)}${rpad(fmt(d.usage.output), 7)}${rpad(fmt(d.usage.cacheCreate), 9)}${rpad(fmt(d.usage.cacheRead), 9)}`);
    }
  } else {
    L.push('by project' + ' '.repeat(18) + 'sess  turns   out    cache-w  cache-r  tool-out');
    const projectRows = opts.by === 'repo' ? [...r.byProject].sort((a, b) => b.usage.cacheRead - a.usage.cacheRead) : r.byProject;
    for (const p of projectRows.slice(0, opts.top * 2)) {
      L.push(`  ${pad(cap(p.project, 25), 26)}${rpad(String(p.sessions), 4)}${rpad(String(p.turns), 7)}${rpad(fmt(p.usage.output), 7)}${rpad(fmt(p.usage.cacheCreate), 9)}${rpad(fmt(p.usage.cacheRead), 9)}${rpad(fmt(p.toolResultTokens), 9)}`);
    }
    if (projectRows.length > opts.top * 2) L.push(`  … +${projectRows.length - opts.top * 2} more`);
  }
  L.push('');

  if (opts.poolpool) {
    L.push('poolpool (per-project, from its API)' + ' '.repeat(2) + 'jobs   input   output');
    if (!opts.poolpool.length) L.push('  none');
    for (const p of opts.poolpool) L.push(`  ${pad(cap(p.project, 25), 26)}${rpad(String(p.jobs), 6)}${rpad(fmt(p.input), 9)}${rpad(fmt(p.output), 9)}`);
    L.push('');
  }

  L.push('by tool' + ' '.repeat(21) + 'calls  result-tok  err');
  for (const t of r.byTool.slice(0, opts.top * 2)) {
    L.push(`  ${pad(capName(t.name, 25), 26)}${rpad(String(t.calls), 6)}${rpad(fmt(t.resultTokens), 12)}${rpad(String(t.errors), 5)}`);
  }
  L.push('');

  L.push('by command head' + ' '.repeat(12) + 'calls  result-tok  err');
  for (const h of r.byHead.slice(0, opts.top * 2)) {
    L.push(`  ${pad(capName(h.key, 25), 26)}${rpad(String(h.calls), 6)}${rpad(fmt(h.resultTokens), 12)}${rpad(String(h.errors), 5)}`);
  }
  L.push('');

  const hasCost = r.byModel.some((m) => m.estCost !== undefined);
  if (opts.cost && !hasCost && r.byModel.length) {
    // --cost asked for but no model matched pricing.json — say so instead of silently printing nothing
    const unknown = r.byModel.map((m) => m.model).join(', ');
    L.push(`cost: — (unknown model ${unknown}; add it to pricing.json)`);
    L.push('');
  }
  if (r.byModel.length > 1 || hasCost) {
    L.push('by model');
    for (const m of r.byModel) {
      const cost = hasCost ? `  est. cost $${m.estCost !== undefined ? m.estCost.toFixed(2) : '—'}` : '';
      L.push(`  ${pad(m.model, 26)}${rpad(String(m.turns), 6)} turns  out ${fmt(m.usage.output)}${cost}`);
    }
    if (hasCost) L.push('  $ from pricing.json — estimate, not a bill');
    L.push('');
  }

  const heaviestRows = opts.by === 'session' ? r.heaviest : r.heaviest.slice(0, opts.top);
  L.push(opts.by === 'session' ? `heaviest sessions (cache-read = context × turns; the real bill) — all ${heaviestRows.length}` : 'heaviest sessions (cache-read = context × turns; the real bill)');
  for (const h of heaviestRows) {
    const cross = h.crossLimit ? `>${fmt(r.ctxLimit)}@t${h.crossLimit.turn}` : `>${fmt(r.ctxLimit)}@—`;
    const intent = h.firstPrompt ? `  "${cap(h.firstPrompt.replace(/\s+/g, ' ').trim(), 40)}"` : '';
    L.push(`  ${h.id}  ${pad(cap(h.project, 23), 24)}${rpad(String(h.turns), 5)} turns  ctx ~${rpad(fmt(h.avgContext), 5)}/turn  read ${rpad(fmt(h.cacheRead), 6)}  out ${rpad(fmt(h.output), 5)}  ${cross}${intent}`);
  }
  L.push('');
  L.push('leaks (est. tokens that entered context)');
  if (!r.findings.length) L.push('  none — nice');
  for (const f of r.findings) {
    L.push(`  ${pad(f.title, 44)} ×${rpad(String(f.count), 4)}  ~${rpad(fmt(f.tokens), 6)}  → ${f.hint}`);
    for (const s of f.samples.slice(0, opts.top)) L.push(`      ↳ ${s}`);
  }
  return L.join('\n');
}

/** `heaviest` is uncapped on `Report` (so `--by session` can show all of it) — cap it back
 *  here for the default digest-shaped `--json` output; a full dump would grow with every
 *  session in the window, working against "keep it a digest". `--by session` opts back in. */
export function renderJson(r: Report, top: number, by?: 'session' | 'day' | 'repo', poolpool?: PoolpoolRow[]): string {
  const byProject = by === 'repo' ? [...r.byProject].sort((a, b) => b.usage.cacheRead - a.usage.cacheRead) : r.byProject;
  const capped = { ...r, byProject, heaviest: by === 'session' ? r.heaviest : r.heaviest.slice(0, top) };
  return JSON.stringify(poolpool ? { ...capped, poolpool } : capped, null, 2);
}

/** ≤ 12 lines — a SessionStart-hook budget. Findings use `key` (not the full `title`) so it
 *  stays both shorter and stable to match on ("long-context", not "Long-context sessions…"). */
export function renderBrief(r: Report): string {
  const L: string[] = [];
  L.push(`tally — ${windowLabel(r)} · out ${fmt(r.usage.output)} · cache-read ${fmt(r.usage.cacheRead)} · ${r.sessionCount} sessions`);
  const heaviest = r.heaviest.slice(0, 3);
  if (heaviest.length) {
    L.push('heaviest:');
    for (const h of heaviest) L.push(`  ${h.id} ${h.project}  ${h.turns}t  ctx ~${fmt(h.avgContext)}  read ${fmt(h.cacheRead)}`);
  }
  L.push(r.findings.length ? 'leaks:' : 'leaks: none');
  for (const f of r.findings.slice(0, 3)) L.push(`  ${f.key} ×${f.count} ~${fmt(f.tokens)} → ${f.hint}`);
  return L.join('\n');
}

/** `tally tools`: sunset-by-data — invocations per personal CLI/skill/guard outcome per month. */
export function renderTools(rows: ToolUsageRow[], skills: SkillRow[], guards: GuardRow[]): string {
  const L: string[] = [];
  L.push('tool                 month    calls  projects');
  if (!rows.length) L.push('  none');
  for (const r of rows) {
    const note = r.flag ? '  ← < 5: merge/archive?' : '';
    L.push(`  ${pad(cap(r.tool, 18), 19)}${pad(r.month, 9)}${rpad(String(r.calls), 6)}${rpad(String(r.projects), 9)}${note}`);
  }
  L.push('');
  L.push('skills' + ' '.repeat(19) + 'month    calls');
  if (!skills.length) L.push('  none');
  for (const s of skills) L.push(`  ${pad(cap(s.skill, 18), 19)}${pad(s.month, 9)}${rpad(String(s.calls), 6)}`);
  L.push('');
  L.push('guards               outcome    count');
  if (!guards.length) L.push('  none');
  for (const g of guards) L.push(`  ${pad(cap(g.rule, 18), 19)}${pad(g.outcome, 11)}${rpad(String(g.count), 5)}`);
  return L.join('\n');
}

/** `tally tools --builtin`: how much each harness tool (Bash/Read/Agent/…) gets used, across
 *  every project — a different question from the CLI-adoption table above. */
export function renderBuiltin(rows: BuiltinRow[]): string {
  const L: string[] = [];
  L.push('builtin tool           calls  result-tok  projects  top project');
  if (!rows.length) L.push('  none');
  for (const r of rows) {
    L.push(`  ${pad(cap(r.tool, 22), 23)}${rpad(String(r.calls), 6)}${rpad(fmt(r.resultTokens), 12)}${rpad(String(r.projects), 9)}  ${r.topProject}`);
  }
  return L.join('\n');
}

/** `tally files`: what a file costs by *staying* in context, not by being read once.
 *  cost = tokens × turns resident, which is the shape of the cache-read bill and
 *  the only ranking that tells you which file is worth splitting. */
export function renderFiles(rows: FatFileRow[], opts: { top: number; window: string; scanned: number; resident?: ResidentRow[] }): string {
  const L: string[] = [];
  L.push(`tally files — ${opts.window} · cost = result tokens × turns they stay in context`);
  L.push('');
  L.push('  file                                         reads  tok/read  resident      cost');
  if (!rows.length) L.push('  none — no whole-file reads over ~1k tokens in this window');
  for (const r of rows.slice(0, opts.top)) {
    const per = r.reads ? Math.round(r.tokens / r.reads) : 0;
    const res = r.reads ? Math.round(r.residentTurns / r.reads) : 0;
    const via = r.viaBash ? `  (${r.viaBash} via bash)` : '';
    L.push(`  ${pad(capPath(r.path, 42), 43)}${rpad(String(r.reads), 5)}${rpad(fmt(per), 10)}${rpad('~' + res, 10)}${rpad(fmt(r.cost), 10)}${via}`);
  }
  const total = rows.reduce((n, r) => n + r.cost, 0);
  L.push('');
  L.push(`  ${fmt(total)} across ${rows.length} file(s), ${opts.scanned.toLocaleString()} tool calls scanned.`);
  L.push('  A read at turn N is re-sent on every turn after it, so the fix is upstream of');
  L.push('  the read: split the file, read the slice (grep / sed -n / limit+offset), and');
  L.push('  /compact after a big one. Resident turns stop at a compaction, so this is a');
  L.push('  floor, not a ceiling.');
  const res = opts.resident ?? [];
  if (res.length) {
    L.push('');
    L.push('always resident (never read — loaded into every turn, sized on disk now)');
    L.push('  file                                          tok     turns      cost');
    for (const r of res.slice(0, Math.max(5, Math.min(opts.top, 10)))) {
      L.push(`  ${pad(capPath(r.path, 42), 43)}${rpad(fmt(r.tokens), 6)}${rpad(r.turns.toLocaleString(), 10)}${rpad(fmt(r.cost), 10)}`);
    }
    L.push('  A line cut here is cut from every turn of every session in that repo.');
  }
  return L.join('\n');
}

/** paths are identified by their tail, so truncate from the left */
function capPath(s: string, n: number): string {
  return s.length > n ? '…' + s.slice(s.length - (n - 1)) : s;
}

/** markdown digest — same content discipline as text mode, table-shaped for reports/artifacts */
export function renderMd(r: Report, opts: { top: number; by?: 'session' | 'day' | 'repo'; poolpool?: PoolpoolRow[] }): string {
  const L: string[] = [];
  const perTurn = r.turns ? Math.round(r.usage.cacheRead / r.turns) : 0;
  L.push(`# tally — ${windowLabel(r)} window`);
  L.push('');
  L.push(`${r.files} transcripts · ${r.sessionCount} sessions · ${r.turns.toLocaleString()} API turns · out **${fmt(r.usage.output)}** · cache-write **${fmt(r.usage.cacheCreate)}** · cache-read **${fmt(r.usage.cacheRead)}** · avg ctx/turn **~${fmt(perTurn)}**`);
  const lc = r.findings.find((f) => f.key === 'long-context');
  if (lc && r.usage.cacheRead) {
    L.push('');
    L.push(`**Burned above ${fmt(r.ctxLimit)}: ~${fmt(lc.tokens)}** (${Math.round((lc.tokens / r.usage.cacheRead) * 100)}% of cache-read) across ${lc.count} long-context sessions.`);
  }
  L.push('');

  const heaviestRows = opts.by === 'session' ? r.heaviest : r.heaviest.slice(0, opts.top);
  L.push('## Heaviest sessions');
  L.push('');
  L.push(`| session | project | turns | avg ctx | peak | >${fmt(r.ctxLimit)}@turn | burned >${fmt(r.ctxLimit)} | intent |`);
  L.push('|---|---|--:|--:|--:|:-:|--:|---|');
  for (const h of heaviestRows) {
    const intent = h.firstPrompt ? cap(h.firstPrompt.replace(/\s+/g, ' ').trim(), 40) : '—';
    L.push(`| ${h.id} | ${h.project} | ${h.turns} | ${fmt(h.avgContext)} | ${fmt(h.peakCtx)} | ${h.crossLimit ? 't' + h.crossLimit.turn : '—'} | ${h.burnedAbove ? '~' + fmt(h.burnedAbove) : '0'} | ${intent} |`);
  }
  L.push('');

  L.push('## Leaks');
  L.push('');
  if (!r.findings.length) {
    L.push('none — nice');
  } else {
    L.push('| finding | count | ~tokens | fix |');
    L.push('|---|--:|--:|---|');
    for (const f of r.findings) L.push(`| ${f.title} | ×${f.count} | ~${fmt(f.tokens)} | ${f.hint} |`);
    L.push('');
    L.push('Top sample per finding:');
    for (const f of r.findings) if (f.samples.length) L.push(`- **${f.key}** — ${f.samples[0]}`);
  }
  L.push('');

  if (opts.by === 'day') {
    L.push(`## By day (${windowLabel(r)})`);
    L.push('');
    L.push('| day | sess | turns | out | cache-w | cache-r |');
    L.push('|---|--:|--:|--:|--:|--:|');
    for (const d of r.byDay) L.push(`| ${d.day} | ${d.sessions} | ${d.turns} | ${fmt(d.usage.output)} | ${fmt(d.usage.cacheCreate)} | ${fmt(d.usage.cacheRead)} |`);
  } else {
    L.push('## By project');
    L.push('');
    L.push('| project | sess | turns | out | cache-w | cache-r | tool-out |');
    L.push('|---|--:|--:|--:|--:|--:|--:|');
    const projectRowsMd = opts.by === 'repo' ? [...r.byProject].sort((a, b) => b.usage.cacheRead - a.usage.cacheRead) : r.byProject;
    for (const p of projectRowsMd.slice(0, opts.top * 2)) {
      L.push(`| ${p.project} | ${p.sessions} | ${p.turns} | ${fmt(p.usage.output)} | ${fmt(p.usage.cacheCreate)} | ${fmt(p.usage.cacheRead)} | ${fmt(p.toolResultTokens)} |`);
    }
    if (projectRowsMd.length > opts.top * 2) L.push(`| _… +${projectRowsMd.length - opts.top * 2} more_ | | | | | | |`);
  }
  L.push('');

  if (opts.poolpool) {
    L.push('## poolpool (per-project, from its API)');
    L.push('');
    if (!opts.poolpool.length) {
      L.push('none');
    } else {
      L.push('| project | jobs | input | output |');
      L.push('|---|--:|--:|--:|');
      for (const p of opts.poolpool) L.push(`| ${p.project} | ${p.jobs} | ${fmt(p.input)} | ${fmt(p.output)} |`);
    }
    L.push('');
  }

  L.push('## By tool');
  L.push('');
  L.push('| tool | calls | result-tok | err |');
  L.push('|---|--:|--:|--:|');
  for (const t of r.byTool.slice(0, opts.top * 2)) L.push(`| ${t.name} | ${t.calls} | ${fmt(t.resultTokens)} | ${t.errors} |`);
  L.push('');

  L.push('## By command head');
  L.push('');
  L.push('| head | calls | result-tok | err |');
  L.push('|---|--:|--:|--:|');
  for (const h of r.byHead.slice(0, opts.top * 2)) L.push(`| ${h.key} | ${h.calls} | ${fmt(h.resultTokens)} | ${h.errors} |`);
  L.push('');

  const hasCost = r.byModel.some((m) => m.estCost !== undefined);
  if (r.byModel.length > 1 || hasCost) {
    L.push('## By model');
    L.push('');
    L.push(hasCost ? '| model | turns | out | est. cost |' : '| model | turns | out |');
    L.push(hasCost ? '|---|--:|--:|--:|' : '|---|--:|--:|');
    for (const m of r.byModel) {
      L.push(hasCost ? `| ${m.model} | ${m.turns} | ${fmt(m.usage.output)} | ${m.estCost !== undefined ? '$' + m.estCost.toFixed(2) : '—'} |` : `| ${m.model} | ${m.turns} | ${fmt(m.usage.output)} |`);
    }
    if (hasCost) L.push('');
    if (hasCost) L.push('_$ from pricing.json — estimate, not a bill._');
    L.push('');
  }

  L.push('_Local transcripts only; usage numbers exact (API `usage` block), tool-result estimates ~chars/4._');
  return L.join('\n');
}
