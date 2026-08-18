import { readdir, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { TranscriptParser, estTokens } from './parse.js';
import type { ParseEvents } from './parse.js';
import { fmt } from './render.js';
import { BIG_RESULT_CHARS, HUGE_RESULT_CHARS, bashLooksLikeLogDump, describe } from './analyze.js';
import type { ToolCall, Turn } from './types.js';

export interface TraceOpts {
  dir: string;
  session?: string; // filename (= session id) prefix
  project?: string; // slug substring
  follow: boolean;
  ctxLimit: number;
}

/** live per-call bucket tag; same thresholds as the batch buckets, minus session-wide ones */
export function classifyCall(c: ToolCall): string | null {
  if (c.isDenied) return 'denied';
  if (c.isError) return 'error';
  if (c.name === 'Bash' && typeof c.input.command === 'string' && bashLooksLikeLogDump(c.input.command)) return 'log-dump';
  if (c.name === 'Read' && !c.input.limit && c.resultLines > 300) return 'read-full-file';
  if (c.resultChars >= HUGE_RESULT_CHARS) return 'huge';
  if (c.resultChars >= BIG_RESULT_CHARS) return 'big';
  if (c.name === 'Agent') return 'subagent';
  return null;
}

export async function findTranscript(opts: Pick<TraceOpts, 'dir' | 'session' | 'project'>): Promise<{ path: string; slug: string } | null> {
  let best: { path: string; slug: string; mtime: number } | null = null;
  for (const dir of opts.dir.split(',').filter(Boolean)) {
    let slugs: string[];
    try {
      slugs = await readdir(dir);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      if (opts.project && !slug.includes(opts.project)) continue;
      let entries: string[];
      try {
        entries = await readdir(join(dir, slug));
      } catch {
        continue;
      }
      for (const f of entries) {
        if (!f.endsWith('.jsonl')) continue;
        if (opts.session && !f.startsWith(opts.session)) continue;
        const path = join(dir, slug, f);
        const st = await stat(path).catch(() => null);
        if (!st || !st.isFile()) continue;
        if (!best || st.mtimeMs > best.mtime) best = { path, slug, mtime: st.mtimeMs };
      }
    }
  }
  return best && { path: best.path, slug: best.slug };
}

function hhmmss(ts: number): string {
  return ts ? new Date(ts).toTimeString().slice(0, 8) : '--:--:--';
}

function delta(d: number): string {
  return (d < 0 ? '-' : '+') + fmt(Math.abs(d));
}

function rpad(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

/**
 * Turn-by-turn line printer. A turn's line is emitted once its picture is complete:
 * when all tool calls it started have results, or when the next turn arrives
 * (tool results always land before the next assistant request).
 */
export class TracePrinter {
  turns = 0;
  peak = 0;
  burned = 0;
  crossTurn: number | null = null;
  private cross2xDone = false;
  private prevCtx = 0;
  private pendingTurn: Turn | null = null;
  private pendingNo = 0;
  private open = new Set<string>();
  private done: ToolCall[] = [];
  private keyCounts = new Map<string, number>();

  constructor(private ctxLimit: number, private out: (line: string) => void) {}

  onEvents(ev: ParseEvents): void {
    // sidechain turns would fake ctx dips and shift turn numbers off the batch
    // view; their tool calls still show, tagged [side]
    if (ev.turn && !ev.turn.isSidechain) {
      this.emit();
      this.turns++;
      this.pendingTurn = ev.turn;
      this.pendingNo = this.turns;
    }
    for (const c of ev.started) {
      this.open.add(c.id);
      if (!c.isSidechain) {
        const n = (this.keyCounts.get(c.inputKey) ?? 0) + 1;
        this.keyCounts.set(c.inputKey, n);
        if (n === 3) this.out(`      ⚠ same call ×3 — ${describe(c)}`);
      }
    }
    for (const c of ev.completed) {
      this.open.delete(c.id);
      this.done.push(c);
    }
    if (this.pendingTurn && this.open.size === 0) this.emit();
  }

  /** flush only when nothing is in flight — a turn mid-tool-call keeps waiting for its result sizes */
  flushIdle(): void {
    if (this.open.size === 0) this.emit();
  }

  /** flush the buffered turn (used on stream end and idle) */
  emit(): void {
    const t = this.pendingTurn;
    if (!t) return;
    this.pendingTurn = null;
    const ctx = t.usage.cacheRead;
    const calls = this.done;
    this.done = [];
    let summary = '';
    if (calls.length) {
      const big = calls.reduce((a, b) => (b.resultChars > a.resultChars ? b : a));
      const tag = classifyCall(big);
      const dur = big.completedTs && big.timestamp ? ((big.completedTs - big.timestamp) / 1000).toFixed(1) + 's' : '';
      summary = `${describe(big)} →${fmt(estTokens(big.resultChars))} tok`;
      if (dur) summary += ` ⏱${dur}`;
      if (tag) summary += ` [${tag}]`;
      if (big.isSidechain) summary += ' [side]';
      if (calls.length > 1) summary += ` +${calls.length - 1} more`;
    }
    this.out(`t${this.pendingNo}`.padEnd(6) + `${hhmmss(t.timestamp)}  ctx ${rpad(fmt(ctx), 6)} ${rpad(delta(ctx - this.prevCtx), 7)}  out ${rpad(fmt(t.usage.output), 5)}  ${summary}`);
    this.prevCtx = ctx;
    if (ctx > this.peak) this.peak = ctx;
    this.burned += Math.max(0, ctx - this.ctxLimit);
    if (this.crossTurn === null && ctx >= this.ctxLimit) {
      this.crossTurn = this.pendingNo;
      this.out(`      ⚠ ctx crossed ${fmt(this.ctxLimit)} at turn ${this.pendingNo} — /compact or new session`);
    }
    if (!this.cross2xDone && ctx >= 2 * this.ctxLimit) {
      this.cross2xDone = true;
      this.out(`      ⚠ ctx crossed ${fmt(2 * this.ctxLimit)} (2× limit) at turn ${this.pendingNo}`);
    }
  }

  summary(): void {
    this.emit();
    const crossed = this.crossTurn === null ? 'never' : `t${this.crossTurn}`;
    this.out(`— ${this.turns} turns · peak ctx ${fmt(this.peak)} · crossed ${fmt(this.ctxLimit)} ${crossed} · burned above ${fmt(this.ctxLimit)} ~${fmt(this.burned)}`);
  }
}

export async function runTrace(opts: TraceOpts, out: (line: string) => void = console.log): Promise<number> {
  const found = await findTranscript(opts);
  if (!found) {
    console.error(`no transcript found in ${opts.dir}${opts.session ? ` for session ${opts.session}` : ''}${opts.project ? ` (project ${opts.project})` : ''}`);
    return 1;
  }
  out(`tracing ${found.slug}/${found.path.split('/').pop()}${opts.follow ? ' (follow — ^C to stop)' : ''}`);
  let parser = new TranscriptParser(found.slug);
  let printer = new TracePrinter(opts.ctxLimit, out);
  let offset = 0;
  let rem = '';
  const readNew = async (): Promise<void> => {
    const st = await stat(found.path).catch(() => null);
    if (!st) return;
    if (st.size < offset) {
      // truncated/replaced (e.g. session restarted) — start over cleanly
      out('— transcript truncated, restarting trace');
      parser = new TranscriptParser(found.slug);
      printer = new TracePrinter(opts.ctxLimit, out);
      offset = 0;
      rem = '';
    }
    if (st.size <= offset) return;
    const fh = await open(found.path, 'r');
    try {
      const buf = Buffer.alloc(st.size - offset);
      await fh.read(buf, 0, buf.length, offset);
      offset = st.size;
      const chunk = rem + buf.toString('utf8');
      const lines = chunk.split('\n');
      rem = lines.pop() ?? ''; // last piece may be a partial line still being written
      for (const line of lines) printer.onEvents(parser.push(line));
    } finally {
      await fh.close();
    }
  };
  await readNew();
  if (!opts.follow) {
    if (rem) printer.onEvents(parser.push(rem)); // file without trailing newline
    printer.summary();
    return 0;
  }
  printer.flushIdle();
  for (;;) {
    await sleep(500);
    await readNew();
    printer.flushIdle(); // release a completed turn while the session idles, never a mid-call one
  }
}
