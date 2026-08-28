#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { HELP, effectiveSince, parseArgs } from './cli.js';
import { defaultProjectsDir, scan } from './scan.js';
import { analyze, suggestGuards } from './analyze.js';
import { loadPricing } from './pricing.js';
import { renderBrief, renderBuiltin, renderFiles, renderJson, renderMd, renderText, renderTools } from './render.js';
import { runTrace } from './trace.js';
import { isoWeek, loadSnap, saveSnap } from './snap.js';
import { diffReports, renderDiff } from './diff.js';
import { fetchPoolpool } from './poolpool.js';
import { cmdHooks, runHook } from './hooks.js';
import type { HookInput } from './hooks.js';
import { readFile as readFileAsync } from 'node:fs/promises';
import { homedir } from 'node:os';
import { builtinReport, skillsReport, parseGuardLog, toolsReport } from './tools.js';
import { fatFiles, residentFiles } from './files.js';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String((e as Error).message));
    return 2;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (args.version) {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as { version: string };
    console.log(pkg.version);
    return 0;
  }
  if (args.cmd === 'hook') {
    let input: HookInput = {};
    try {
      input = JSON.parse((await readStdin()) || '{}') as HookInput;
    } catch {
      // malformed stdin — run with an empty event rather than crash a hook chain
    }
    const result = runHook(args.hookName ?? '', input);
    if (result.stdout) console.log(result.stdout);
    if (result.message) console.error(result.message);
    return result.exit;
  }
  const dir = args.dir ?? defaultProjectsDir();
  if (args.cmd === 'hooks') {
    if (args.hooksSuggest) {
      const since = effectiveSince(args);
      const s = await scan({ dir, since, project: args.project, session: args.session });
      if (!s.files) {
        console.error(`no transcripts found in ${dir}`);
        return 1;
      }
      const suggestions = suggestGuards(analyze(s, since, Date.now(), args.top, args.ctxLimit));
      console.log(suggestions.length ? suggestions.join('\n') : 'no recurring errors to suggest a guard for');
      return 0;
    }
    const result = await cmdHooks({ install: args.hooksInstall, print: args.hooksPrint, list: args.hooksList, global: args.hooksGlobal, keepLegacy: args.hooksKeepLegacy, target: args.hooksTarget });
    if (result.stdout) console.log(result.stdout);
    if (result.message) console.error(result.message);
    return result.exit;
  }
  if (args.cmd === 'trace') {
    return runTrace({ dir, session: args.session, project: args.project, follow: args.follow, ctxLimit: args.ctxLimit });
  }
  const now = Date.now();
  const since = effectiveSince(args);
  if (args.cmd === 'files') {
    const s = await scan({ dir, since, project: args.project, session: args.session });
    if (!s.files) {
      console.error(`no transcripts found in ${dir}`);
      return 1;
    }
    const rows = fatFiles(s);
    const resident = residentFiles(s);
    const window = since === 0 ? 'all' : `${Math.max(1, Math.round((now - since) / 86_400_000))}d`;
    if (args.json) console.log(JSON.stringify({ files: rows.slice(0, args.top === 5 ? 40 : args.top), resident }, null, 2));
    else console.log(renderFiles(rows, { top: args.top === 5 ? 20 : args.top, window, scanned: s.calls.length, resident }));
    return 0;
  }
  if (args.cmd === 'tools') {
    const s = await scan({ dir, since, project: args.project, session: args.session });
    if (!s.files) {
      console.error(`no transcripts found in ${dir}`);
      return 1;
    }
    if (args.toolsBuiltin) {
      console.log(renderBuiltin(builtinReport(s.calls)));
      return 0;
    }
    let guardLog = '';
    try {
      guardLog = await readFileAsync(join(process.env.TALLY_HOME || join(homedir(), '.tally'), 'guard.log'), 'utf8');
    } catch {
      // no guard.log yet — no hooks have blocked/rewritten anything
    }
    const tools = process.env.TALLY_TOOLS ? process.env.TALLY_TOOLS.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
    console.log(renderTools(toolsReport(s.calls, tools), skillsReport(s.calls), parseGuardLog(guardLog)));
    return 0;
  }
  if (args.cmd === 'diff') {
    const name = args.snapName ?? isoWeek();
    const prev = await loadSnap(name);
    if (!prev) {
      console.error(`no snapshot ${name} — run: tally snap`);
      return 1;
    }
    const s = await scan({ dir, since, project: args.project, session: args.session });
    if (!s.files) {
      console.error(`no transcripts found in ${dir}`);
      return 1;
    }
    const cur = analyze(s, since, now, args.top, args.ctxLimit);
    console.log(args.json ? JSON.stringify(diffReports(prev, cur), null, 2) : renderDiff(prev, cur));
    return 0;
  }
  const s = await scan({ dir, since, project: args.project, session: args.session });
  if (!s.files) {
    console.error(`no transcripts found in ${dir}`);
    return 1;
  }
  let pricing;
  if (args.cost) {
    try {
      pricing = loadPricing();
    } catch (e) {
      console.error(`--cost: could not load pricing.json (${(e as Error).message}) — cost column omitted`);
    }
  }
  if (args.cmd === 'snap') {
    const report = analyze(s, since, now, args.top, args.ctxLimit, { pricing });
    const name = args.snapName ?? isoWeek();
    // cap heaviest the same way the digest does — a snapshot grows every session in the window otherwise
    const path = await saveSnap(name, { ...report, heaviest: report.heaviest.slice(0, args.top) });
    console.log(`saved snapshot ${name} → ${path}`);
    return 0;
  }
  const report = analyze(s, since, now, args.top, args.ctxLimit, { pricing });
  let poolpool;
  const poolpoolUrl = args.poolpoolUrl ?? process.env.POOLPOOL_URL;
  if (args.poolpool && args.brief) {
    console.error('--poolpool: not shown in --brief mode (kept it under the 12-line budget) — skipped, not fetched');
  } else if (args.poolpool) {
    if (!poolpoolUrl) {
      console.error('--poolpool: no URL (pass one or set POOLPOOL_URL) — poolpool table omitted');
    } else {
      const days = Math.max(1, Math.round((now - since) / 86_400_000));
      try {
        poolpool = await fetchPoolpool(poolpoolUrl, days);
      } catch (e) {
        console.error(`--poolpool: ${(e as Error).message} — poolpool table omitted`);
      }
    }
  }
  console.log(args.json ? renderJson(report, args.top, args.by, poolpool) : args.md ? renderMd(report, { top: args.top, by: args.by, poolpool }) : args.brief ? renderBrief(report) : renderText(report, { top: args.top, by: args.by, poolpool, cost: args.cost }));
  return 0;
}

// exitCode, not process.exit(): exit() drops stdout still buffered in the pipe (>64KB --json output)
main().then((c) => {
  process.exitCode = c;
}, (e) => {
  console.error(e);
  process.exitCode = 1;
});
