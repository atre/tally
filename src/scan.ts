import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseTranscript, emptyUsage, addUsage } from './parse.js';
import type { Scan, Session } from './types.js';

/** Transcript dirs to scan (comma-separated). `TALLY_PROJECTS` wins; otherwise
 *  CLAUDE_CONFIG_DIR (or ~/.claude) plus ~/.claude-dev when it exists (dev harness). */
export function defaultProjectsDir(): string {
  if (process.env.TALLY_PROJECTS) return process.env.TALLY_PROJECTS;
  const dirs = [join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')];
  const dev = join(homedir(), '.claude-dev', 'projects');
  if (!dirs.includes(dev) && existsSync(dev)) dirs.push(dev);
  return dirs.join(',');
}

export interface ScanOpts {
  dir: string;
  since: number; // ms epoch; 0 = all
  project?: string; // substring filter on slug
  session?: string; // filename (= session id) prefix filter
}

export async function scan(opts: ScanOpts): Promise<Scan> {
  const out: Scan = { turns: [], calls: [], hookOutputs: [], sessions: new Map(), files: 0, bytes: 0 };
  // resumed sessions can replay records into a new file — dedupe across files too
  const seenReq = new Set<string>();
  const seenCall = new Set<string>();
  const seenHook = new Set<string>();
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
  return out;
}
