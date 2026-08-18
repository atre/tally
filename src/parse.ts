import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { HookOutput, ToolCall, Turn, Usage } from './types.js';

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
}

export function addUsage(a: Usage, b: Usage): void {
  a.input += b.input;
  a.output += b.output;
  a.cacheRead += b.cacheRead;
  a.cacheCreate += b.cacheCreate;
}

export function totalUsage(u: Usage): number {
  return u.input + u.output + u.cacheRead + u.cacheCreate;
}

/** `-Users-x-git-squirt` → `~/git/squirt`-ish: last two path segments joined. */
export function projectLabel(slug: string, cwd?: string): string {
  const src = cwd && cwd.length > 0 ? cwd : slug.replace(/^-/, '/').replace(/-/g, '/');
  const parts = src.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || slug;
}

export function estTokens(chars: number): number {
  return Math.round(chars / 4);
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Splits a shell command on `||`, `&&`, `|`, `;`, `$(`, a standalone `(`, and newlines — but
 *  only outside single/double quotes. A plain regex split (the previous approach) treats every
 *  `|` as a separator regardless of quoting, so a quoted grep pattern like `"squirt-guard\|squirt
 *  init"` gets sliced apart at the `\|`, leaving a bogus segment (`squirt init" …`) that starts
 *  with a tool name in command position — a false positive, not real usage. */
function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    // Backslash escapes the next char (bash honors this inside double quotes and unquoted;
    // single quotes take backslash literally, so skip this branch there) — without it, `\"`
    // inside a double-quoted string reads as the string's end instead of a literal quote.
    if (ch === '\\' && quote !== "'" && i + 1 < command.length) {
      cur += ch + command[i + 1];
      i++;
      continue;
    }
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (command.startsWith('||', i) || command.startsWith('&&', i)) {
      segments.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (command.startsWith('$(', i)) {
      segments.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (ch === '|' || ch === ';' || ch === '\n') {
      segments.push(cur);
      cur = '';
      continue;
    }
    if (ch === '(' && !/[\w$]/.test(command[i - 1] ?? '')) {
      segments.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  segments.push(cur);
  return segments;
}

/** which of `tools` a shell command actually INVOKES — the name in command position (start of
 *  the command, or right after `|`, `&&`, `||`, `;`, `$(`, `(`), optionally behind env assignments
 *  (`FOO=1 peep …`), `npx <tool>`, or the off-PATH `node ~/git/<tool>/bin/<tool>.js` form. Flags
 *  (`pulse --brief`), paths (`cd ~/git/brief`, `ls ~/git/looksy/x`) and plain words (`echo brief`)
 *  are NOT usage — a `\b` match would count all of those. */
export function usedTools(command: string, tools: readonly string[]): string[] {
  const used: string[] = [];
  const segments = splitCommandSegments(command);
  for (const raw of segments) {
    let seg = raw.trim();
    seg = seg.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)*/, ''); // env assignments
    seg = seg.replace(/^(?:sudo|exec|command|time|nice)\s+/, ''); // wrappers that don't change which tool runs
    seg = seg.replace(/^npx\s+(?:-y\s+|--yes\s+)?/, '');
    const head = /^(\S+)/.exec(seg)?.[1] ?? '';
    for (const tool of tools) {
      if (used.includes(tool)) continue;
      const nodeForm = new RegExp(`^node\\s+\\S*/${escapeRegExp(tool)}/bin/[^\\s/]+\\.[cm]?js(?:\\s|$)`);
      if (head === tool || nodeForm.test(seg)) used.push(tool);
    }
  }
  return used;
}

/** true when `path` is `dir` itself or lives anywhere under it — a plain `===` would miss e.g.
 *  running a tool from `<repo>/src`, wrongly treating that as "used from outside its own repo". */
export function isWithinDir(path: string, dir: string): boolean {
  const p = path.replace(/\/$/, '');
  return p === dir || p.startsWith(`${dir}/`);
}

export function inputKey(name: string, input: Record<string, unknown>): string {
  let s: string;
  try {
    s = JSON.stringify(input);
  } catch {
    s = String(input);
  }
  return `${name}:${s.length}:${s.slice(0, 200)}`;
}

// verified against real transcripts (2026-08-17): "…doesn't want to proceed with this tool use…",
// "Request interrupted by user for tool use", "Permission for this action was denied by the
// Claude Code auto mode classifier…". Deliberately narrower than a bare "permission denied" —
// that also matches ordinary shell output (e.g. `chmod`/`mkdir` errors) and would misclassify them.
const DENIAL_RE = /doesn't want to proceed|Request interrupted by user|denied by the Claude Code/i;

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('');
  }
  return '';
}

function contentSize(content: unknown): { chars: number; lines: number } {
  if (content == null) return { chars: 0, lines: 0 };
  if (typeof content === 'string') return { chars: content.length, lines: content.split('\n').length };
  if (Array.isArray(content)) {
    let chars = 0;
    let lines = 0;
    for (const b of content) {
      if (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string') {
        const t = (b as { text: string }).text;
        chars += t.length;
        lines += t.split('\n').length;
      } else if (b && typeof b === 'object' && (b as { type?: string }).type === 'image') {
        chars += 1500 * 4; // rough image cost
      }
    }
    return { chars, lines };
  }
  const s = JSON.stringify(content);
  return { chars: s.length, lines: s.split('\n').length };
}

export interface ParsedFile {
  turns: Turn[];
  calls: ToolCall[];
  hookOutputs: HookOutput[];
}

interface Rec {
  type?: string;
  requestId?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  isSidechain?: boolean;
  uuid?: string;
  attachment?: {
    type?: string;
    hookEvent?: string;
    hookName?: string;
    content?: unknown;
  };
  message?: {
    model?: string;
    usage?: Record<string, number>;
    content?: unknown;
  };
}

/** what a single pushed line produced — lets `tally trace` react turn-by-turn */
export interface ParseEvents {
  turn?: Turn;
  started: ToolCall[];
  completed: ToolCall[];
}

/**
 * Incremental JSONL parser: feed lines, read `turns`/`calls`. Usage is deduped by
 * requestId (Claude Code writes several `assistant` records per API request, each
 * carrying the same usage). Batch scan and live trace share this.
 */
export class TranscriptParser {
  readonly turns: Turn[] = [];
  readonly calls: ToolCall[] = [];
  readonly hookOutputs: HookOutput[] = [];
  private seenReq = new Set<string>();
  private pending = new Map<string, ToolCall>();
  private fileSession = '';

  constructor(private slug: string, private since = 0) {}

  push(line: string): ParseEvents {
    const ev: ParseEvents = { started: [], completed: [] };
    if (!line.startsWith('{')) return ev;
    let o: Rec;
    try {
      o = JSON.parse(line) as Rec;
    } catch {
      return ev;
    }
    if (o.type !== 'assistant' && o.type !== 'user' && o.type !== 'attachment') return ev;
    const ts = o.timestamp ? Date.parse(o.timestamp) : 0;
    if (ts && ts < this.since) return ev;
    const sessionId = o.sessionId ?? this.fileSession;
    if (!this.fileSession && o.sessionId) this.fileSession = o.sessionId;
    const project = projectLabel(this.slug, o.cwd);

    if (o.type === 'attachment') {
      const a = o.attachment;
      if (a && a.type === 'hook_success' && typeof a.content === 'string' && a.content.length > 0) {
        this.hookOutputs.push({
          id: o.uuid ?? '',
          sessionId,
          project,
          hook: a.hookEvent ?? a.hookName ?? 'unknown',
          chars: a.content.length,
          timestamp: ts,
          isSidechain: Boolean(o.isSidechain),
        });
      }
      return ev;
    }

    const m = o.message;
    if (!m) return ev;
    const content = Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [];

    if (o.type === 'assistant') {
      const u = m.usage;
      if (u && o.requestId && !this.seenReq.has(o.requestId)) {
        this.seenReq.add(o.requestId);
        const turn: Turn = {
          requestId: o.requestId,
          sessionId,
          project,
          cwd: o.cwd ?? '',
          model: m.model ?? 'unknown',
          timestamp: ts,
          isSidechain: Boolean(o.isSidechain),
          usage: {
            input: u.input_tokens ?? 0,
            output: u.output_tokens ?? 0,
            cacheRead: u.cache_read_input_tokens ?? 0,
            cacheCreate: u.cache_creation_input_tokens ?? 0,
          },
        };
        this.turns.push(turn);
        ev.turn = turn;
      }
      for (const b of content) {
        if (b.type !== 'tool_use') continue;
        const input = (b.input ?? {}) as Record<string, unknown>;
        const name = String(b.name ?? '?');
        const call: ToolCall = {
          id: String(b.id ?? ''),
          sessionId,
          project,
          cwd: o.cwd,
          name,
          timestamp: ts,
          input,
          inputKey: inputKey(name, input),
          resultChars: 0,
          resultLines: 0,
          isError: false,
          isDenied: false,
          isSidechain: Boolean(o.isSidechain),
        };
        this.pending.set(call.id, call);
        this.calls.push(call);
        ev.started.push(call);
      }
    } else {
      for (const b of content) {
        if (b.type !== 'tool_result') continue;
        const call = this.pending.get(String(b.tool_use_id ?? ''));
        if (!call) continue;
        const { chars, lines } = contentSize(b.content);
        call.resultChars = chars;
        call.resultLines = lines;
        call.isError = Boolean(b.is_error);
        call.isDenied = DENIAL_RE.test(resultText(b.content));
        call.completedTs = ts;
        this.pending.delete(call.id);
        ev.completed.push(call);
      }
    }
    return ev;
  }
}

/** Stream one whole transcript file through TranscriptParser. */
export async function parseTranscript(path: string, slug: string, since = 0): Promise<ParsedFile> {
  const p = new TranscriptParser(slug, since);
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) p.push(line);
  return { turns: p.turns, calls: p.calls, hookOutputs: p.hookOutputs };
}
