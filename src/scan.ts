import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseTranscript, emptyUsage, addUsage } from './parse.js';
import type { Scan, Session } from './types.js';

/** Transcript dirs to scan (comma-separated). `TALLY_PROJECTS` wins; otherwise the UNION of
 *  CLAUDE_CONFIG_DIR, ~/.claude and ~/.claude-dev (whichever exist, deduped). The env var must
 *  widen the union, never replace it: the old shape (`CLAUDE_CONFIG_DIR ?? ~/.claude`) collapsed
 *  to dev-only transcripts inside any dev-instance session/hook — 192 of 573 files scanned,
 *  which silently hid all main-instance usage from `tally tools` (found 2026-08-28). */
export function defaultProjectsDir(env: Record<string, string | undefined> = process.env, home: string = homedir(), exists: (p: string) => boolean = existsSync): string {
  if (env.TALLY_PROJECTS) return env.TALLY_PROJECTS;
  const dirs: string[] = [];
  for (const base of [env.CLAUDE_CONFIG_DIR, join(home, '.claude'), join(home, '.claude-dev')]) {
    if (!base) continue;
    const d = join(base, 'projects');
    if (!dirs.includes(d) && exists(d)) dirs.push(d);
  }
  return dirs.length ? dirs.join(',') : join(home, '.claude', 'projects');
}

export interface ScanOpts {
  dir: string;
  since: number; // ms epoch; 0 = all
  project?: string; // substring filter on slug
  session?: string; // filename (= session id) prefix filter
}

export async function scan(opts: ScanOpts): Promise<Scan> {
  const out: Scan = { turns: [], calls: [], hookOutputs: [], hookRuns: [], sessions: new Map(), files: 0, bytes: 0 };
  // resumed sessions can replay records into a new file — dedupe across files too
  const seenReq = new Set<string>();
  const seenCall = new Set<string>();
  const seenHook = new Set<string>();
  const seenRun = new Set<string>();
  const firstPromptBySession = new Map<string, { ts: number; text: string }>();
  const earliestBySession = new Map<string, number>();
  for (const dir of opts.dir.split(',').filter(Boolean)) {
    let slugs: string[];
    try {
      slugs = await readdir(dir);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      if (opts.project && !slug.includes(opts.project)) continue;
      const pdir = join(dir, slug);
      let entries: string[];
      try {
        entries = await readdir(pdir);
      } catch {
        continue;
      }
      for (const f of entries) {
        if (!f.endsWith('.jsonl')) continue;
        if (opts.session && !f.startsWith(opts.session)) continue;
        const path = join(pdir, f);
        const st = await stat(path).catch(() => null);
        if (!st || !st.isFile()) continue;
        if (opts.since && st.mtimeMs < opts.since) continue; // untouched since window start
        out.files++;
        out.bytes += st.size;
        const parsed = await parseTranscript(path, slug, opts.since);
        for (const t of parsed.turns) {
          if (seenReq.has(t.requestId)) continue;
          seenReq.add(t.requestId);
          out.turns.push(t);
        }
        for (const c of parsed.calls) {
          if (c.id && seenCall.has(c.id)) continue;
          if (c.id) seenCall.add(c.id);
          out.calls.push(c);
        }
        for (const h of parsed.hookOutputs) {
          if (h.id && seenHook.has(h.id)) continue;
          if (h.id) seenHook.add(h.id);
          out.hookOutputs.push(h);
        }
        for (const r of parsed.hookRuns) {
          if (r.id && seenRun.has(r.id)) continue;
          if (r.id) seenRun.add(r.id);
          out.hookRuns.push(r);
        }
        for (const p of parsed.prompts) {
          const cur = firstPromptBySession.get(p.sessionId);
          if (!cur || p.timestamp < cur.ts) firstPromptBySession.set(p.sessionId, { ts: p.timestamp, text: p.text });
        }
        for (const t of parsed.turns) {
          const cur = earliestBySession.get(t.sessionId);
          if (parsed.earliestTs && (cur === undefined || parsed.earliestTs < cur)) earliestBySession.set(t.sessionId, parsed.earliestTs);
        }
      }
    }
  }
  // sessions
  for (const t of out.turns) {
    let s = out.sessions.get(t.sessionId);
    if (!s) {
      s = {
        id: t.sessionId,
        project: t.project,
        cwd: t.cwd,
        firstTs: t.timestamp,
        lastTs: t.timestamp,
        turns: 0,
        usage: emptyUsage(),
        toolCalls: 0,
        models: new Set(),
        ctx: [],
      } satisfies Session;
      out.sessions.set(t.sessionId, s);
    }
    s.turns++;
    addUsage(s.usage, t.usage);
    if (!t.isSidechain) s.ctx.push({ ts: t.timestamp, cacheRead: t.usage.cacheRead });
    s.models.add(t.model);
    if (t.timestamp && t.timestamp < s.firstTs) s.firstTs = t.timestamp;
    if (t.timestamp > s.lastTs) s.lastTs = t.timestamp;
  }
  for (const c of out.calls) {
    const s = out.sessions.get(c.sessionId);
    if (s) s.toolCalls++;
  }
  for (const [id, s] of out.sessions) {
    const fp = firstPromptBySession.get(id);
    if (fp) s.firstPrompt = fp.text;
    const e = earliestBySession.get(id);
    if (opts.since && e && e < opts.since) s.partial = true;
  }
  return out;
}
