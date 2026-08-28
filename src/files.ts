import { homedir } from 'node:os';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { estTokens } from './parse.js';
import type { Scan, Session, ToolCall } from './types.js';

export interface FatFileRow {
  path: string; // display path, home-relative
  reads: number;
  tokens: number; // Σ tokens read into context
  maxTokens: number; // biggest single read
  residentTurns: number; // Σ turns those reads stayed in context
  cost: number; // Σ tokens × turns resident — the cache-read bill this file caused
  projects: string[];
  viaBash: number; // how many of the reads were `cat`/`sed -n`/`head`/`tail`, not the Read tool
}

/** a `cat`/`sed -n`/`head`/`tail`/`less` with exactly one path-looking argument.
 *  Deliberately narrow: a pipeline or a second path means the result is not
 *  attributable to one file, and a wrong attribution is worse than a missing row. */
export function bashReadTarget(cmd: string): string | null {
  const c = cmd.trim();
  if (/[|><]|&&|;/.test(c)) return null;
  const m = /^(?:cat|bat|head|tail|less|sed)\s+(.*)$/s.exec(c);
  if (!m) return null;
  const args = m[1].split(/\s+/).filter(Boolean);
  const paths = args.filter((a) => !a.startsWith('-') && /[/.]/.test(a) && !/^\d/.test(a) && !/^'?\d+[pq,]/.test(a));
  return paths.length === 1 ? paths[0].replace(/^['"]|['"]$/g, '') : null;
}

/** file this call pulled into context, or null if it isn't a whole-file read */
export function readTarget(c: ToolCall): { path: string; viaBash: boolean } | null {
  if (c.isError || c.isDenied) return null;
  if (c.name === 'Read' || c.name === 'NotebookRead') {
    const p = c.input.file_path;
    return typeof p === 'string' ? { path: p, viaBash: false } : null;
  }
  if (c.name === 'Bash') {
    const cmd = typeof c.input.command === 'string' ? c.input.command : '';
    const p = bashReadTarget(cmd);
    return p ? { path: p, viaBash: true } : null;
  }
  return null;
}

/** Turns a result stays in context after it lands: every later main-loop turn,
 *  up to a compaction. A compaction shows up in the ctx series as context
 *  falling to a fraction of its running peak — after that the old result is no
 *  longer re-sent, so charging it further would overstate the bill. */
export function residentTurns(s: Session | undefined, ts: number): number {
  if (!s || !s.ctx.length) return 0;
  let i = s.ctx.findIndex((p) => p.ts >= ts);
  if (i < 0) return 0;
  let peak = 0;
  for (let j = i; j < s.ctx.length; j++) {
    peak = Math.max(peak, s.ctx[j].cacheRead);
    if (peak > 0 && s.ctx[j].cacheRead < peak * 0.5) return j - i;
  }
  return s.ctx.length - i;
}

function display(path: string): string {
  const home = homedir();
  let p = path.startsWith(home) ? '~' + path.slice(home.length) : path;
  if (p.startsWith('~/')) p = p.slice(2);
  return p;
}

/** Files ranked by what they cost: tokens × the turns they stay in context.
 *  A 30k-token read at turn 46 of a 600-turn session is re-sent ~550 times —
 *  which is why file size, not read count, is what a refactor should target. */
export function fatFiles(scan: Scan, opts: { top?: number; minTokens?: number } = {}): FatFileRow[] {
  const min = opts.minTokens ?? 1_000;
  const rows = new Map<string, FatFileRow>();
  for (const c of scan.calls) {
    if (c.isSidechain) continue; // subagent context is its own window, not this session's bill
    const t = readTarget(c);
    if (!t) continue;
    const tokens = estTokens(c.resultChars);
    if (tokens < min) continue;
    const key = display(t.path);
    let row = rows.get(key);
    if (!row) {
      row = { path: key, reads: 0, tokens: 0, maxTokens: 0, residentTurns: 0, cost: 0, projects: [], viaBash: 0 };
      rows.set(key, row);
    }
    const turns = residentTurns(scan.sessions.get(c.sessionId), c.timestamp);
    row.reads++;
    row.tokens += tokens;
    row.maxTokens = Math.max(row.maxTokens, tokens);
    row.residentTurns += turns;
    row.cost += tokens * turns;
    if (t.viaBash) row.viaBash++;
    if (!row.projects.includes(c.project)) row.projects.push(c.project);
  }
  const all = [...rows.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
  return opts.top ? all.slice(0, opts.top) : all;
}

export interface ResidentRow {
  path: string; // display path
  tokens: number; // size on disk now, in tokens
  turns: number; // main-loop turns it was resident for
  cost: number; // tokens × turns
  scope: string; // the project it applies to, or "every session"
}

/** Files that are never "read" and are billed on every single turn anyway:
 *  the CLAUDE.md chain. They cannot show up in `fatFiles` — no tool call ever
 *  pulls them — but a 22 KB project CLAUDE.md across 5,400 turns outweighs every
 *  row in that table. Sized from disk NOW, so it is an estimate of the current
 *  file against a past week: shrink the file and the number is already stale,
 *  which is the point. */
export function residentFiles(scan: Scan, opts: { top?: number } = {}): ResidentRow[] {
  const turnsByCwd = new Map<string, number>();
  let total = 0;
  for (const t of scan.turns) {
    if (t.isSidechain) continue;
    total++;
    const cwd = t.cwd || scan.sessions.get(t.sessionId)?.cwd || '';
    if (cwd) turnsByCwd.set(cwd, (turnsByCwd.get(cwd) ?? 0) + 1);
  }
  const rows: ResidentRow[] = [];
  const add = (path: string, turns: number, scope: string) => {
    let bytes = 0;
    try {
      bytes = statSync(path).size;
    } catch {
      return; // gone, or never existed — nothing to charge
    }
    const tokens = estTokens(bytes);
    rows.push({ path: display(path), tokens, turns, cost: tokens * turns, scope });
  };
  for (const [cwd, turns] of turnsByCwd) add(join(cwd, 'CLAUDE.md'), turns, display(cwd));
  add(join(homedir(), '.claude', 'CLAUDE.md'), total, 'every session');
  const all = rows.filter((r) => r.tokens > 0).sort((a, b) => b.cost - a.cost);
  return opts.top ? all.slice(0, opts.top) : all;
}
