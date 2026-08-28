export interface PoolpoolRow {
  project: string;
  jobs: number;
  input: number;
  output: number;
}

/** shape of `GET /usage?days=N` on poolpool's own API (verified 2026-08-17 against
 *  ~/git/poolpool/src/api.ts — camelCase, already-`Number()`-converted, wrapped in
 *  `{ days, breakdown }`; PLAN.md's first draft assumed a bare snake_case/bigint array). */
export interface PoolpoolUsageRow {
  project: string;
  type: string;
  profile: string;
  totalJobs: number;
  completed: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface PoolpoolUsageResponse {
  days: number;
  breakdown: PoolpoolUsageRow[];
}

/** collapses poolpool's per-(project,type,profile) rows down to one row per project. */
export function mapPoolpoolRows(breakdown: PoolpoolUsageRow[]): PoolpoolRow[] {
  const byProject = new Map<string, PoolpoolRow>();
  for (const row of breakdown) {
    let p = byProject.get(row.project);
    if (!p) {
      p = { project: row.project, jobs: 0, input: 0, output: 0 };
      byProject.set(row.project, p);
    }
    p.jobs += row.totalJobs;
    p.input += row.inputTokens;
    p.output += row.outputTokens;
  }
  return [...byProject.values()].sort((a, b) => (b.input + b.output) - (a.input + a.output));
}

/** opt-in only (flag or env); 3s timeout; failure is the caller's problem to report — never throws away silently here either. */
export async function fetchPoolpool(url: string, days: number): Promise<PoolpoolRow[]> {
  const clampedDays = Math.min(Math.max(1, Math.round(days)), 365); // poolpool's own API clamps to 365 server-side too — mirrored here so `--since all` doesn't send a decades-wide query
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/usage?days=${clampedDays}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`poolpool ${url} → HTTP ${res.status}`);
    const data = (await res.json()) as PoolpoolUsageResponse;
    return mapPoolpoolRows(data.breakdown);
  } finally {
    clearTimeout(timer);
  }
}
