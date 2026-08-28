export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

/** One API request (deduped across the multiple `assistant` records that share a requestId). */
export interface Turn {
  requestId: string;
  sessionId: string;
  project: string; // decoded from ~/.claude/projects/<slug>
  cwd: string;
  model: string;
  timestamp: number; // ms epoch
  isSidechain: boolean;
  usage: Usage;
}

export interface ToolCall {
  id: string;
  sessionId: string;
  project: string;
  cwd?: string; // raw absolute cwd, when available — project is a lossy last-two-segments label, not enough for accurate "inside this repo" checks
  name: string;
  timestamp: number;
  input: Record<string, unknown>;
  inputKey: string; // stable hash-ish string of input for retry detection
  resultChars: number; // size of tool_result content
  resultLines: number;
  isError: boolean;
  isDenied: boolean; // user rejected / interrupted this tool call
  isSidechain: boolean;
  completedTs?: number; // tool_result record timestamp; with .timestamp gives span duration
}

export interface Session {
  id: string;
  project: string;
  cwd: string;
  firstTs: number;
  lastTs: number;
  turns: number;
  usage: Usage;
  toolCalls: number;
  models: Set<string>;
  /** per-turn context (cache-read) in turn order — MAIN loop only; sidechain
   * turns stay in `usage`/`turns` totals but would fake dips in the curve */
  ctx: { ts: number; cacheRead: number }[];
  firstPrompt?: string;
}

/** a `type: "attachment"` / `attachment.type: "hook_success"` record — a hook's stdout/JSON
 *  `additionalContext`/`permissionDecisionReason` actually injected into the model's context.
 *  `attachment.content` is what enters context; `attachment.stdout` is the raw process output
 *  (may be a JSON envelope never shown to the model), so only `content` is measured here. */
export interface HookOutput {
  id: string; // record uuid — dedup key across resumed-session file replays (toolUseID is NOT unique: one hook group's multiple commands share it)
  sessionId: string;
  project: string;
  hook: string; // attachment.hookEvent, e.g. "SessionStart", "PreToolUse", "PostToolUse"
  chars: number;
  timestamp: number;
  isSidechain: boolean;
}

export interface Scan {
  turns: Turn[];
  calls: ToolCall[];
  hookOutputs: HookOutput[];
  sessions: Map<string, Session>;
  files: number;
  bytes: number;
}

export interface Finding {
  key: string;
  title: string;
  count: number;
  /** estimated tokens attributable (chars/4 of tool_result etc.) */
  tokens: number;
  hint: string;
  samples: string[];
}

export interface Report {
  since: number;
  until: number;
  files: number;
  sessionCount: number;
  turns: number;
  ctxLimit: number;
  usage: Usage;
  byProject: ProjectRow[];
  byDay: DayRow[];
  byTool: ToolRow[];
  byHead: { key: string; calls: number; resultTokens: number; errors: number }[];
  byModel: { model: string; turns: number; usage: Usage; estCost?: number }[];
  findings: Finding[];
  heaviest: SessionRow[];
}

/** first turn where context reached a threshold (1-based) */
export interface CtxCross {
  turn: number;
  ts: number;
}

export interface SessionRow {
  id: string;
  project: string;
  turns: number;
  avgContext: number;
  output: number;
  cacheRead: number;
  peakCtx: number;
  crossLimit: CtxCross | null; // ctx ≥ --ctx-limit
  cross2x: CtxCross | null; // ctx ≥ 2 × --ctx-limit
  /** Σ max(0, ctx − limit) per turn — tokens re-read above the limit */
  burnedAbove: number;
  /** cache-read per turn in order; rendered only in --json */
  ctxSeries: number[];
  firstPrompt?: string;
}

export interface DayRow {
  day: string; // UTC date, YYYY-MM-DD
  sessions: number;
  turns: number;
  usage: Usage;
}

export interface ProjectRow {
  project: string;
  sessions: number;
  turns: number;
  usage: Usage;
  toolResultTokens: number;
}

export interface ToolRow {
  name: string;
  calls: number;
  resultTokens: number;
  errors: number;
}
