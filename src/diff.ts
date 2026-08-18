import { fmt } from './render.js';
import type { Report } from './types.js';

export interface MetricDelta {
  key: string;
  prev: number;
  cur: number;
}

export interface FindingDelta {
  key: string;
  title: string;
  prevCount: number;
  curCount: number;
  prevTokens: number;
  curTokens: number;
}

export interface ReportDiff {
  metrics: MetricDelta[];
  findings: FindingDelta[];
}

export function diffReports(prev: Report, cur: Report): ReportDiff {
  const metrics: MetricDelta[] = [
    { key: 'sessions', prev: prev.sessions, cur: cur.sessions },
    { key: 'turns', prev: prev.turns, cur: cur.turns },
    { key: 'out', prev: prev.usage.output, cur: cur.usage.output },
    { key: 'cache-write', prev: prev.usage.cacheCreate, cur: cur.usage.cacheCreate },
    { key: 'cache-read', prev: prev.usage.cacheRead, cur: cur.usage.cacheRead },
    { key: 'uncached-in', prev: prev.usage.input, cur: cur.usage.input },
  ];
  const keys = new Set([...prev.findings.map((f) => f.key), ...cur.findings.map((f) => f.key)]);
  const findings: FindingDelta[] = [...keys].map((key) => {
    const p = prev.findings.find((f) => f.key === key);
    const c = cur.findings.find((f) => f.key === key);
    return { key, title: (c ?? p)!.title, prevCount: p?.count ?? 0, curCount: c?.count ?? 0, prevTokens: p?.tokens ?? 0, curTokens: c?.tokens ?? 0 };
  });
  return { metrics, findings };
}

function pctStr(prev: number, cur: number): string {
  if (prev === cur) return '±0';
  if (prev === 0) return 'new';
  const pct = Math.round(((cur - prev) / prev) * 100);
  return (pct > 0 ? '+' : '') + pct + '%';
}

export function renderDiff(prev: Report, cur: Report): string {
  const d = diffReports(prev, cur);
  const L: string[] = [];
  for (const m of d.metrics) L.push(`${m.key} ${fmt(m.prev)} → ${fmt(m.cur)} (${pctStr(m.prev, m.cur)})`);
  if (d.findings.length) {
    L.push('');
    for (const f of d.findings) L.push(`${f.key} ×${f.prevCount} → ×${f.curCount}  ~${fmt(f.prevTokens)} → ~${fmt(f.curTokens)}`);
  }
  return L.join('\n');
}
