import { homedir } from 'node:os';

export interface Args {
  cmd?: 'trace' | 'snap' | 'diff' | 'hook' | 'hooks' | 'tools' | 'files';
  since: number; // ms epoch
  sinceExplicit: boolean; // true only if --since/-s was actually passed, not defaulted
  dir?: string;
  project?: string;
  session?: string; // session-id (filename) prefix filter; trace: also selects the tail target
  snapName?: string; // snap/diff: snapshot name (default: current ISO week)
  hookName?: string; // hook: pre-bash | pre-read | ctx-guard | post-tool
  hooksInstall: boolean; // hooks --install
  hooksPrint: boolean; // hooks --print
  hooksGlobal: boolean; // hooks --global
  hooksSuggest: boolean; // hooks --suggest
  hooksList: boolean; // hooks --list
  hooksKeepLegacy: boolean; // hooks --install --keep-legacy
  hooksTarget?: string; // hooks --target <config-dir>
  toolsBuiltin: boolean; // tools --builtin
  by?: 'session' | 'day' | 'repo';
  follow: boolean; // trace: tail the live transcript
  top: number;
  ctxLimit: number; // tokens
  json: boolean;
  md: boolean;
  brief: boolean;
  cost: boolean;
  poolpool: boolean; // opt-in poolpool usage merge
  poolpoolUrl?: string; // overrides POOLPOOL_URL env
  help: boolean;
  version: boolean;
}

/** a named --session should never come back empty just because it predates the *default*
 *  --since window; an explicitly passed --since still narrows it as asked. */
export function effectiveSince(args: Pick<Args, 'since' | 'sinceExplicit' | 'session'>): number {
  return args.session && !args.sinceExplicit ? 0 : args.since;
}

export function parseTokenCount(s: string): number {
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(s);
  if (!m) throw new Error(`bad token count: ${s} (use 150k, 300000, 1.5M)`);
  const mult = m[2] === '' ? 1 : m[2].toLowerCase() === 'k' ? 1_000 : 1_000_000;
  return Math.round(Number(m[1]) * mult);
}

export function parseSince(s: string, now = Date.now()): number {
  const m = /^(\d+)([hdw])$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    const unit = { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as 'h' | 'd' | 'w'];
    return now - n * unit;
  }
  if (s === 'all') return 0;
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`bad --since: ${s} (use 24h, 7d, 2w, all, or ISO date)`);
  return t;
}

export function parseArgs(argv: string[], now = Date.now()): Args {
  const a: Args = { since: now - 7 * 86_400_000, sinceExplicit: false, top: 5, ctxLimit: 150_000, follow: false, json: false, md: false, brief: false, cost: false, poolpool: false, hooksInstall: false, hooksPrint: false, hooksGlobal: false, hooksSuggest: false, hooksList: false, hooksKeepLegacy: false, toolsBuiltin: false, help: false, version: false };
  if (argv[0] === 'trace') {
    a.cmd = 'trace';
    argv = argv.slice(1);
  } else if (argv[0] === 'snap' || argv[0] === 'diff') {
    a.cmd = argv[0];
    argv = argv.slice(1);
    if (argv[0] && !argv[0].startsWith('-')) {
      a.snapName = argv[0];
      argv = argv.slice(1);
    }
  } else if (argv[0] === 'hook') {
    a.cmd = 'hook';
    a.hookName = argv[1];
    argv = argv.slice(2);
  } else if (argv[0] === 'hooks') {
    a.cmd = 'hooks';
    argv = argv.slice(1);
  } else if (argv[0] === 'files' || argv[0] === '--fat-files') {
    // `--fat-files` is the flag spelling people reach for first; same report.
    a.cmd = 'files';
    argv = argv.slice(1);
  } else if (argv[0] === 'tools') {
    a.cmd = 'tools';
    a.since = now - 30 * 86_400_000; // this subcommand's own default window, overridable by an explicit --since below
    argv = argv.slice(1);
  }
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${x} needs a value`);
      return v;
    };
    if (x === '--since' || x === '-s') {
      a.since = parseSince(next(), now);
      a.sinceExplicit = true;
    } else if (x.startsWith('--since=')) {
      a.since = parseSince(x.slice(8), now);
      a.sinceExplicit = true;
    }
    else if (x === '--dir') a.dir = next();
    else if (x === '--project' || x === '-p') a.project = next();
    else if (x === '--top') {
      a.top = Number(next());
      if (!Number.isInteger(a.top) || a.top < 1) throw new Error('--top needs a positive integer');
    }
    else if (x === '--ctx-limit') a.ctxLimit = parseTokenCount(next());
    else if (x.startsWith('--ctx-limit=')) a.ctxLimit = parseTokenCount(x.slice(12));
    else if (x === '--json') a.json = true;
    else if (x === '--md') a.md = true;
    else if (x === '--brief') a.brief = true;
    else if (x === '--cost') a.cost = true;
    else if (x === '--poolpool') {
      a.poolpool = true;
      if (argv[i + 1] && !argv[i + 1].startsWith('-')) a.poolpoolUrl = argv[++i];
    }
    else if (x === '--by') {
      const v = next();
      if (v !== 'session' && v !== 'day' && v !== 'repo') throw new Error(`--by needs session, day, or repo, got: ${v}`);
      a.by = v;
    }
    else if (x === '--follow' || x === '-f') {
      if (a.cmd !== 'trace') throw new Error(`${x} only makes sense with: tally trace`);
      a.follow = true;
    } else if (x === '--session') {
      a.session = next();
    } else if (x === '--install') {
      if (a.cmd !== 'hooks') throw new Error(`${x} only makes sense with: tally hooks`);
      a.hooksInstall = true;
    } else if (x === '--print') {
      if (a.cmd !== 'hooks') throw new Error(`${x} only makes sense with: tally hooks`);
      a.hooksPrint = true;
    } else if (x === '--global') {
      if (a.cmd !== 'hooks') throw new Error(`${x} only makes sense with: tally hooks`);
      a.hooksGlobal = true;
    } else if (x === '--suggest') {
      if (a.cmd !== 'hooks') throw new Error(`${x} only makes sense with: tally hooks`);
      a.hooksSuggest = true;
    } else if (x === '--keep-legacy') {
      if (a.cmd !== 'hooks') throw new Error(`${x} only makes sense with: tally hooks`);
      a.hooksKeepLegacy = true;
    } else if (x === '--list') {
      if (a.cmd !== 'hooks') throw new Error(`${x} only makes sense with: tally hooks`);
      a.hooksList = true;
    } else if (x === '--builtin') {
      if (a.cmd !== 'tools') throw new Error(`${x} only makes sense with: tally tools`);
      a.toolsBuiltin = true;
    } else if (x === '--target') {
      if (a.cmd !== 'hooks') throw new Error(`${x} only makes sense with: tally hooks`);
      a.hooksTarget = next().replace(/^~(?=\/|$)/, homedir());
    } else if (x === '-h' || x === '--help') a.help = true;
    else if (x === '-v' || x === '--version') a.version = true;
    else throw new Error(`unknown arg: ${x}`);
  }
  if ([a.json, a.md, a.brief].filter(Boolean).length > 1) throw new Error('pick one output: --json, --md, or --brief');
  if ([a.hooksInstall, a.hooksPrint, a.hooksSuggest, a.hooksList].filter(Boolean).length > 1) throw new Error('pick one: --install, --print, --list, or --suggest');
  if (a.hooksTarget && a.hooksGlobal) throw new Error('--target and --global are mutually exclusive');
  // flags with no effect on these subcommands used to fail silently — surface it instead
  const UNSUPPORTED_FLAGS: Partial<Record<string, (keyof Args)[]>> = {
    diff: ['md', 'brief', 'cost', 'poolpool'],
    snap: ['json', 'md', 'brief', 'poolpool'],
    tools: ['json', 'md', 'brief', 'cost', 'poolpool'],
    hook: ['json', 'md', 'brief', 'cost', 'poolpool'],
    hooks: ['json', 'md', 'brief', 'cost', 'poolpool'],
    trace: ['json', 'md', 'brief', 'cost', 'poolpool'],
  };
  const unsupported = (a.cmd && UNSUPPORTED_FLAGS[a.cmd]) || [];
  const bad = unsupported.filter((k) => a[k]);
  if (bad.length) throw new Error(`--${bad.join('/--')} not supported by tally ${a.cmd}`);
  return a;
}

export const HELP = `tally — Claude Code token telemetry

usage: tally [--since 7d] [--project <slug-substr>] [--top 5] [--ctx-limit 150k] [--json]
       tally trace [--session <id-prefix>] [--follow] [-p <slug-substr>]
       tally snap [name]                     save a snapshot (default name: current ISO week)
       tally diff [name]                     diff the live scan against a saved snapshot
       tally hook <pre-bash|pre-read|ctx-guard|post-tool|post-bash-mark|stop-feedback>   read a Claude Code hook event from stdin, act on it
       tally hooks --install [--global] [--keep-legacy] [--target <config-dir>] | --print | --list | --suggest   wire tally's hooks into .claude/settings.json (--install absorbs the hand-written curl|sh + sed-guard.sh hooks pre-bash covers unless --keep-legacy, and runs squirt init --claude when squirt is on PATH; --list: show every configured hook + who owns it; --suggest: print-only, top error heads → a guard to consider)
       tally tools [--since 30d]             invocations per personal CLI/skill per month (default 30d) — < 5 outside its own repo → merge/archive candidate
       tally tools --builtin                 per-built-in-tool call counts (Bash/Read/Agent/…) across projects
       tally files [--top 20] [-p <repo>]    (alias: tally --fat-files) files ranked by tokens × turns they stay in context — what to split, grep instead of read, or archive

  --since     24h | 7d | 2w | all | ISO date   (default 7d)
  --project   substring of the ~/.claude/projects slug (e.g. git-squirt)
  --top       samples per finding / rows per table
  --ctx-limit context threshold for long-context findings (default 150k)
  --by        session | day | repo — session: full heaviest-sessions table, no top cap; day: totals per UTC date; repo: per-repo table sorted by cache-read desc
  --session   session-id (filename) prefix filter — narrows the scan to one session
  --dir       transcripts dir(s), comma-separated (default ~/.claude/projects [+ ~/.claude-dev/projects]; env TALLY_PROJECTS)
  --json      machine output (includes per-turn context series)
  --md        markdown digest (weekly report / artifact-friendly)
  --brief     ≤ 12 lines: heaviest 3 sessions + top 3 leaks (SessionStart hook budget)
  --cost      add an est. $ column (by model), from pricing.json — estimate, not a bill
  --poolpool [url]  merge in poolpool's per-project usage (default url: POOLPOOL_URL env), shown as its own table
  --target    hooks: point --install/--list at <dir>/settings.json (e.g. ~/.claude-dev) instead of ~/.claude/settings.json

trace: one line per turn (ctx, Δ, out, biggest tool span + bucket tag), live
threshold warnings. Default target is the most recently active transcript;
narrow with --session / -p. --follow tails it until ^C.

Reads local transcripts only. Nothing leaves the machine.`;
