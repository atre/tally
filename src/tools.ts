import { homedir } from 'node:os';
import { join } from 'node:path';
import { estTokens, isWithinDir, usedTools } from './parse.js';
import type { HookRun, ToolCall } from './types.js';

export interface SkillRow {
  skill: string;
  month: string; // UTC YYYY-MM
  calls: number;
}

/** `Skill` tool calls by skill name × month — feeds the eventual `tally tools` sunset review. */
export function skillsReport(calls: ToolCall[]): SkillRow[] {
  const byKey = new Map<string, SkillRow>();
  for (const c of calls) {
    if (c.name !== 'Skill') continue;
    const skill = typeof c.input.skill === 'string' ? c.input.skill : 'unknown';
    const month = new Date(c.timestamp).toISOString().slice(0, 7);
    const key = `${skill}|${month}`;
    let row = byKey.get(key);
    if (!row) {
      row = { skill, month, calls: 0 };
      byKey.set(key, row);
    }
    row.calls++;
  }
  return [...byKey.values()].sort((a, b) => b.calls - a.calls);
}

export interface GuardRow {
  rule: string;
  outcome: string;
  count: number;
}

/** parses `${TALLY_HOME}/guard.log` lines (`ts rule outcome`, appended by src/hooks.ts). */
export function parseGuardLog(text: string): GuardRow[] {
  const byKey = new Map<string, GuardRow>();
  for (const line of text.split('\n')) {
    const m = /^\S+\s+(\S+)\s+(\S+)\s*$/.exec(line);
    if (!m) continue;
    const [, rule, outcome] = m;
    const key = `${rule}|${outcome}`;
    let row = byKey.get(key);
    if (!row) {
      row = { rule, outcome, count: 0 };
      byKey.set(key, row);
    }
    row.count++;
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count);
}

export interface BuiltinRow {
  tool: string;
  calls: number;
  resultTokens: number;
  projects: number;
  topProject: string;
}

/** per-built-in-tool call counts across all projects (sidechain calls INCLUDED — subagent usage
 *  is usage) — feeds `tally tools --builtin`, a different question from `toolsReport`'s adoption
 *  tracking of personal CLIs: this is how much the harness's own tools (Bash/Read/Agent/…) get
 *  used, not who's dogfooding what. */
export function builtinReport(calls: ToolCall[]): BuiltinRow[] {
  const byTool = new Map<string, { tool: string; calls: number; resultTokens: number; projectCalls: Map<string, number>; seen: string[] }>();
  for (const c of calls) {
    let r = byTool.get(c.name);
    if (!r) {
      r = { tool: c.name, calls: 0, resultTokens: 0, projectCalls: new Map(), seen: [] };
      byTool.set(c.name, r);
    }
    r.calls++;
    r.resultTokens += estTokens(c.resultChars);
    if (!r.projectCalls.has(c.project)) r.seen.push(c.project);
    r.projectCalls.set(c.project, (r.projectCalls.get(c.project) ?? 0) + 1);
  }
  return [...byTool.values()]
    .map((r) => {
      let topProject = r.seen[0] ?? '';
      let topCalls = -1;
      for (const p of r.seen) {
        const n = r.projectCalls.get(p) ?? 0;
        if (n > topCalls) {
          topCalls = n;
          topProject = p;
        }
      }
      return { tool: r.tool, calls: r.calls, resultTokens: r.resultTokens, projects: r.projectCalls.size, topProject };
    })
    .sort((a, b) => b.calls - a.calls);
}

export interface ToolUsageRow {
  tool: string;
  month: string; // UTC YYYY-MM
  calls: number;
  projects: number;
  flag: boolean; // < 5 calls/month outside its own repo → candidate for merge/archive
}

export const DEFAULT_TOOLS = ['looksy', 'peep', 'squirt', 'tally', 'snuff', 'brief', 'pulse', 'texter', 'trusty'];

/** Bash calls per personal CLI × month, counting only calls made from outside that
 *  tool's own repo — using it on itself isn't the adoption signal this is trying to measure.
 *  `< 5/month` flags a tool as a merge/archive candidate. Prefers the call's raw `cwd` (accurate
 *  at any depth); falls back to the lossy `project` label (only accurate at the repo root) when
 *  `cwd` wasn't recorded. */
export function toolsReport(calls: ToolCall[], tools: string[] = DEFAULT_TOOLS, gitHome = process.env.TALLY_GIT || join(homedir(), 'git')): ToolUsageRow[] {
  const byKey = new Map<string, { tool: string; month: string; calls: number; projects: Set<string> }>();
  for (const c of calls) {
    if (c.name !== 'Bash' || typeof c.input.command !== 'string') continue;
    for (const tool of usedTools(c.input.command, tools)) { // command-position match only — flags/paths aren't usage
      const ownRepo = c.cwd ? isWithinDir(c.cwd, join(gitHome, tool)) : c.project === `git/${tool}`;
      if (ownRepo) continue;
      const month = new Date(c.timestamp).toISOString().slice(0, 7);
      const key = `${tool}|${month}`;
      let row = byKey.get(key);
      if (!row) {
        row = { tool, month, calls: 0, projects: new Set() };
        byKey.set(key, row);
      }
      row.calls++;
      row.projects.add(c.project);
    }
  }
  return [...byKey.values()]
    .map((r) => ({ tool: r.tool, month: r.month, calls: r.calls, projects: r.projects.size, flag: r.calls < 5 }))
    .sort((a, b) => a.tool.localeCompare(b.tool) || a.month.localeCompare(b.month));
}

export interface HookRunRow {
  tool: string;
  hook: string; // hook event, e.g. "SessionStart", "Stop", "PreToolUse"
  month: string; // UTC YYYY-MM
  runs: number;
  projects: number;
}

/** Hook-fired runs per personal CLI × hook event × month — the half of adoption `toolsReport`
 *  can't see: pulse/brief on SessionStart and snuff on Stop run as hooks, never as Bash calls.
 *  Attribution is the same command-position `usedTools` tokenizer over the recorded
 *  `attachment.command`, with the same own-repo skip. Counts are a floor: records without a
 *  `command` field (older harness versions) can't be attributed at all. */
export function hookRunsReport(runs: HookRun[], tools: string[] = DEFAULT_TOOLS, gitHome = process.env.TALLY_GIT || join(homedir(), 'git')): HookRunRow[] {
  const byKey = new Map<string, { tool: string; hook: string; month: string; runs: number; projects: Set<string> }>();
  for (const r of runs) {
    for (const tool of usedTools(r.command, tools)) {
      const ownRepo = r.cwd ? isWithinDir(r.cwd, join(gitHome, tool)) : r.project === `git/${tool}`;
      if (ownRepo) continue;
      const month = new Date(r.timestamp).toISOString().slice(0, 7);
      const key = `${tool}|${r.hook}|${month}`;
      let row = byKey.get(key);
      if (!row) {
        row = { tool, hook: r.hook, month, runs: 0, projects: new Set() };
        byKey.set(key, row);
      }
      row.runs++;
      row.projects.add(r.project);
    }
  }
  return [...byKey.values()]
    .map((r) => ({ tool: r.tool, hook: r.hook, month: r.month, runs: r.runs, projects: r.projects.size }))
    .sort((a, b) => a.tool.localeCompare(b.tool) || a.month.localeCompare(b.month) || b.runs - a.runs);
}
