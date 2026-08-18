import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/scan.js';
import { analyze, bashLooksLikeLogDump, suggestGuards } from '../src/analyze.js';
import { parseArgs, parseSince, parseTokenCount, effectiveSince } from '../src/cli.js';
import { projectLabel, inputKey, parseTranscript, TranscriptParser, usedTools } from '../src/parse.js';
import { classifyCall, findTranscript, runTrace } from '../src/trace.js';
import { describe as describeCall } from '../src/analyze.js';
import { readFile, mkdtemp, mkdir, writeFile, utimes, readdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { renderBrief, renderJson, renderMd, renderText } from '../src/render.js';
import { costOf, loadPricing } from '../src/pricing.js';
import { saveSnap, loadSnap } from '../src/snap.js';
import { diffReports, renderDiff } from '../src/diff.js';
import { mapPoolpoolRows } from '../src/poolpool.js';
import { runHook, mergeHooks, cmdHooks, listHooks, renderHooksList, findDuplicateHooks } from '../src/hooks.js';
import { parseGuardLog, skillsReport, toolsReport } from '../src/tools.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures');

test('scan + analyze fixture', async () => {
  const s = await scan({ dir: FIX, since: 0 });
  assert.equal(s.files, 5);
  assert.equal(s.turns.length, 13, 'usage deduped by requestId within and across files');
  assert.equal(s.turns.filter((t) => t.requestId === 'r1').length, 1, 's3 replay of r1 dropped');
  assert.equal(s.calls.length, 8);
  assert.equal(s.hookOutputs.length, 1, 's5\'s SessionStart hook_success block');
  assert.equal(s.sessions.size, 4);
  assert.equal(s.sessions.get('s1')?.turns, 5, 'sidechain turn counts in totals');
  assert.equal(s.sessions.get('s1')?.ctx.length, 4, 'sidechain turn excluded from ctx series');
  const r = analyze(s, 0, Date.parse('2026-08-16T00:00:00Z'));
  assert.equal(r.usage.output, 1_150);
  assert.equal(r.usage.cacheRead, 1_526_000);
  assert.equal(r.byProject[0].project, 'git/demo');
  const keys = r.findings.map((f) => f.key);
  assert.ok(keys.includes('retries'), 'second identical Read is a retry');
  assert.ok(keys.includes('read-full-file'));
  assert.ok(keys.includes('log-dump'));
  assert.ok(keys.includes('errors'));
  assert.ok(keys.includes('denials'));
  // no double counting: each call in exactly one tool bucket (long-context counts sessions, hook-output counts hook blocks, neither counts ToolCalls)
  const total = r.findings.filter((f) => f.key !== 'long-context' && f.key !== 'hook-output').reduce((n, f) => n + f.count, 0);
  assert.equal(total, 8);
  const hookOutput = r.findings.find((f) => f.key === 'hook-output')!;
  assert.equal(hookOutput.count, 1);
  assert.equal(hookOutput.tokens, 500, '2000 chars / 4');
  assert.match(hookOutput.samples[0], /SessionStart ×1 ~500 tok/);
  const denials = r.findings.find((f) => f.key === 'denials')!;
  assert.equal(denials.count, 1, 'the rejected tool call, not double-counted as an error');
  const errs = r.findings.find((f) => f.key === 'errors')!;
  assert.equal(errs.count, 4, 'denial (also is_error) claimed by denials bucket first, not re-counted here');
  assert.match(errs.samples[0], /^Bash git push ×2 ~\d+ tok · e\.g\. cd \/Users\/x\/git\/demo && git push origin main$/, 'errors grouped by command head, cd prefix stripped for the key');
  assert.equal(errs.samples.length, 3, 'git push, npm test, ls');
  const txt = renderText(r, { top: 3 });
  assert.match(txt, /4 sessions/);
  assert.match(txt, /git\/demo/);
  assert.equal(r.byHead.find((h) => h.key === 'Bash git push')?.calls, 2);
  assert.match(txt, /^by command head/m);
  assert.match(txt, /^  Bash git push\s+2\s/m);
  assert.match(suggestGuards(r)[0], /^Bash git push ×2 → guard: \/\^git push\\b\/ /, 'regex is over the bash command — tool name stripped');
});

test('context growth: crossings, peak, burned, bucket first', async () => {
  const s = await scan({ dir: FIX, since: 0 });
  const r = analyze(s, 0, Date.parse('2026-08-16T00:00:00Z'));

  // s2 climbs 50k→400k over 6 turns → heaviest by cache-read
  const h = r.heaviest[0];
  assert.equal(h.id, 's2');
  assert.equal(h.crossLimit?.turn, 3, 'first ≥150k at turn 3 (180k)');
  assert.equal(h.crossLimit?.ts, Date.parse('2026-08-15T09:00:02Z'));
  assert.equal(h.cross2x?.turn, 5, 'first ≥300k at turn 5 (320k)');
  assert.equal(h.peakCtx, 400_000);
  assert.equal(h.burnedAbove, 550_000, '30k+100k+170k+250k above 150k');
  assert.deepEqual(h.ctxSeries, [50_000, 120_000, 180_000, 250_000, 320_000, 400_000]);

  // s1 (flat 50k ctx) never crosses; its sidechain turn must not dent the series
  const h1 = r.heaviest.find((x) => x.id === 's1');
  assert.equal(h1?.crossLimit, null);
  assert.equal(h1?.burnedAbove, 0);
  assert.equal(h1?.avgContext, 50_000, 'avg over main-loop series, not totals');
  assert.equal(h1?.ctxSeries.length, 4);

  // long-context bucket is FIRST, ahead of bigger-token tool buckets
  assert.equal(r.findings[0].key, 'long-context');
  assert.equal(r.findings[0].count, 1, 'only s2 has avg ctx > 150k');
  assert.equal(r.findings[0].tokens, 550_000);
  assert.match(r.findings[0].samples[0], /^s2 git\/demo: crossed 150k at turn 3\/6, peak 400k, ~550k burned above 150k → \/compact or new session at turn 3$/);

  const txt = renderText(r, { top: 3 });
  assert.match(txt, />150k@t3/, 'heaviest table shows crossing turn');
  assert.match(txt, />150k@—/, 's1 never crossed');
  assert.ok(!txt.includes('ctxSeries'), 'no per-turn dump in text mode');

  // honest threshold: raising the limit empties the bucket and relabels
  const r300 = analyze(s, 0, Date.parse('2026-08-16T00:00:00Z'), 5, 300_000);
  assert.ok(!r300.findings.some((f) => f.key === 'long-context'), 'avg 220k < 300k limit');
  assert.match(renderText(r300, { top: 3 }), />300k@t5/);
});

test('since filter drops old records', async () => {
  const s = await scan({ dir: FIX, since: Date.parse('2026-08-15T10:00:02.5Z') });
  assert.equal(s.turns.length, 3, 's1 r3/r4 (10:00:03/04Z) + s5 rh1 (11:00:01Z) are the only records at/after the cutoff');
});

test('parseSince', () => {
  const now = 1_000_000_000_000;
  assert.equal(parseSince('24h', now), now - 86_400_000);
  assert.equal(parseSince('2w', now), now - 14 * 86_400_000);
  assert.equal(parseSince('all', now), 0);
  assert.throws(() => parseSince('yesterday', now));
});

test('parseArgs', () => {
  const a = parseArgs(['--since', '1d', '--json', '-p', 'squirt', '--top', '3'], 1_000_000_000_000);
  assert.equal(a.json, true);
  assert.equal(a.project, 'squirt');
  assert.equal(a.top, 3);
  assert.equal(a.ctxLimit, 150_000, 'default');
  assert.equal(a.since, 1_000_000_000_000 - 86_400_000);
  assert.equal(parseArgs(['--ctx-limit', '300k']).ctxLimit, 300_000);
  assert.equal(parseArgs(['--ctx-limit=1.5M']).ctxLimit, 1_500_000);
  assert.throws(() => parseArgs(['--wat']));
  assert.throws(() => parseArgs(['--top', 'x']), /positive integer/);
  assert.throws(() => parseArgs(['--top', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--follow']), /tally trace/);
  assert.equal(parseArgs(['trace', '--follow', '--session', 'abc']).cmd, 'trace');
});

test('renderMd', async () => {
  const s = await scan({ dir: FIX, since: 0 });
  const r = analyze(s, 0, Date.parse('2026-08-16T00:00:00Z'));
  const md = renderMd(r, { top: 3 });
  assert.match(md, /^# tally — /);
  assert.match(md, /\| session \| project \| turns \| avg ctx \| peak \| >150k@turn \| burned >150k \|/);
  assert.match(md, /\| s2 \| git\/demo \| 6 \| 220k \| 400k \| t3 \| ~550k \|/);
  assert.match(md, /\| s1 \| git\/demo \| 5 \| 50k \| 50k \| — \| 0 \|/);
  assert.match(md, /\*\*Burned above 150k: ~550k\*\* \(36% of cache-read\)/);
  assert.match(md, /- \*\*long-context\*\* — s2 git\/demo: crossed 150k at turn 3\/6/);
  const leaksIdx = md.indexOf('## Leaks');
  assert.ok(md.indexOf('Long-context sessions', leaksIdx) < md.indexOf('| Tool errors'), 'long-context row first');
});

test('parseArgs md flag', () => {
  assert.equal(parseArgs(['--md']).md, true);
  assert.throws(() => parseArgs(['--md', '--json']), /pick one/);
});

test('--by day|session, --session drill-down', async () => {
  assert.equal(parseArgs(['--by', 'day']).by, 'day');
  assert.equal(parseArgs(['--by', 'session']).by, 'session');
  assert.throws(() => parseArgs(['--by', 'week']));
  assert.equal(parseArgs(['--session', 's2']).session, 's2', '--session now valid outside trace');

  const s = await scan({ dir: FIX, since: 0 });
  const until = Date.parse('2026-08-16T00:00:00Z');
  const r = analyze(s, 0, until);
  const txt = renderText(r, { top: 3, by: 'day' });
  assert.match(txt, /^  2026-08-15\s+4\s+13/m, '4 sessions, 13 turns, every fixture turn on 2026-08-15');

  const filtered = await scan({ dir: FIX, since: 0, session: 's2' });
  assert.equal(filtered.sessions.size, 1);
});

test('effectiveSince: a named --session is never silently emptied by the *default* --since window', () => {
  const now = Date.now();
  const base = { since: now - 7 * 86_400_000, sinceExplicit: false };
  assert.equal(effectiveSince({ ...base, session: 'old1' }), 0, 'no explicit --since + --session → show the whole session');
  assert.equal(effectiveSince({ ...base, session: undefined }), base.since, 'no --session → default window applies as normal');
  assert.equal(effectiveSince({ ...base, session: 'old1', sinceExplicit: true }), base.since, 'explicit --since + --session → the explicit window still wins');
});

test('--session finds an old file, at both the file-mtime AND per-record timestamp layers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tally-oldsession-'));
  const slugDir = join(dir, '-Users-x-git-old');
  await mkdir(slugDir);
  const ts = '2020-01-01T00:00:00Z';
  await writeFile(join(slugDir, 'old1.jsonl'), `{"type":"assistant","requestId":"r1","sessionId":"old1","cwd":"/x","timestamp":"${ts}","message":{"model":"claude-test","usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":1,"cache_creation_input_tokens":1},"content":[]}}\n`);
  // touch the file's mtime to match its old content timestamp, so a recent --since would exclude it at the file level too
  const old = new Date(ts);
  await utimes(join(slugDir, 'old1.jsonl'), old, old);

  const recentSince = Date.now() - 7 * 86_400_000;
  const withoutSession = await scan({ dir, since: recentSince });
  assert.equal(withoutSession.files, 0, 'sanity check: the mtime prefilter does exclude it by default');

  // this is what index.ts actually passes when --session is named without an explicit --since: since=0
  const withSession = await scan({ dir, since: 0, session: 'old1' });
  assert.equal(withSession.files, 1);
  assert.equal(withSession.turns.length, 1, 'the record-level since filter (inside parseTranscript) must also see since=0, not just the file-mtime prefilter');
});

test('renderJson caps heaviest to top by default, uncaps with --by session', async () => {
  const s = await scan({ dir: FIX, since: 0 });
  const r = analyze(s, 0, Date.parse('2026-08-16T00:00:00Z'));
  assert.equal(r.heaviest.length, 4, 'analyze() itself returns the full uncapped list');
  assert.equal(JSON.parse(renderJson(r, 2)).heaviest.length, 2, 'default --json caps like the digest does');
  assert.equal(JSON.parse(renderJson(r, 2, 'session')).heaviest.length, 4, '--by session opts back into the full list');
});

test('loadPricing drops a malformed entry instead of producing $NaN', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tally-pricing-'));
  const path = join(dir, 'pricing.json');
  await writeFile(path, JSON.stringify({ good: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, bad: { input: 3 } }));
  const rates = loadPricing(path);
  assert.deepEqual(Object.keys(rates), ['good']);
});

test('runHook on an unknown name never blocks but says so on stderr', () => {
  const r = runHook('pre-bahs', {});
  assert.equal(r.exit, 0);
  assert.match(r.message ?? '', /unknown hook "pre-bahs"/);
});

test('findTranscript searches every comma-separated dir, not just the first', async () => {
  const other = await mkdtemp(join(tmpdir(), 'tally-otherdir-'));
  const slugDir = join(other, '-Users-x-git-elsewhere');
  await mkdir(slugDir);
  await writeFile(join(slugDir, 'zz9.jsonl'), '{"type":"assistant","requestId":"r1","sessionId":"zz9","cwd":"/x","timestamp":"2026-08-15T10:00:00Z","message":{"model":"claude-test","usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":1,"cache_creation_input_tokens":1},"content":[]}}\n');

  const found = await findTranscript({ dir: `${FIX},${other}`, session: 'zz9' });
  assert.ok(found?.path.endsWith('zz9.jsonl'), 'second dir in the comma list must still be searched');
});

test('--cost: est. cost per model, opt-in, never throws on unknown model', async () => {
  assert.equal(parseArgs(['--cost']).cost, true);
  const s = await scan({ dir: FIX, since: 0 });
  const until = Date.parse('2026-08-16T00:00:00Z');
  const pricing = { 'claude-test': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
  const r = analyze(s, 0, until, 5, 150_000, { pricing });
  assert.ok(Number.isFinite(r.byModel[0].estCost) && r.byModel[0].estCost! > 0);
  const txt = renderText(r, { top: 3 });
  assert.match(txt, /est\. cost/);
  assert.match(txt, /not a bill/);

  const rNoPricing = analyze(s, 0, until);
  assert.equal(rNoPricing.byModel[0].estCost, undefined);
  assert.ok(!renderText(rNoPricing, { top: 3 }).includes('$'), 'no --cost → no $ in output');

  const rUnknownModel = analyze(s, 0, until, 5, 150_000, { pricing: { 'some-other-model': pricing['claude-test'] } });
  assert.equal(rUnknownModel.byModel[0].estCost, undefined, 'unknown model → estCost undefined, never throws');
  const unknownTxt = renderText(rUnknownModel, { top: 3, cost: true });
  assert.match(unknownTxt, /cost: — \(unknown model claude-test; add it to pricing\.json\)/, '--cost with no priced model says so instead of printing nothing');
  assert.ok(!renderText(rUnknownModel, { top: 3 }).includes('unknown model'), 'without --cost the hint stays quiet');

  assert.equal(costOf({ input: 0, output: 1_000_000, cacheRead: 0, cacheCreate: 0 }, pricing['claude-test']), 15);
});

test('snap + diff: save/load roundtrip, diff of a report against itself', async () => {
  process.env.TALLY_HOME = await mkdtemp(join(tmpdir(), 'tally-home-'));
  try {
    const s = await scan({ dir: FIX, since: 0 });
    const r = analyze(s, 0, Date.parse('2026-08-16T00:00:00Z'));
    await saveSnap('w1', r);
    assert.deepEqual(await loadSnap('w1'), r);
    assert.equal(await loadSnap('does-not-exist'), undefined);

    const diff = renderDiff(r, r);
    assert.match(diff, /^out 1\.1k → 1\.1k \(±0\)/m);
    assert.match(diff, /long-context ×1 → ×1/);

    assert.equal(parseArgs(['snap', 'w1']).cmd, 'snap');
    assert.equal(parseArgs(['snap', 'w1']).snapName, 'w1');
    assert.equal(parseArgs(['diff']).cmd, 'diff');
    assert.equal(parseArgs(['diff']).snapName, undefined, 'defaults to current ISO week at run time');

    assert.equal(parseArgs(['diff', '--json']).json, true, '--json is real for diff, unlike --md/--brief/--cost/--poolpool below');
    assert.deepEqual(Object.keys(diffReports(r, r)).sort(), ['findings', 'metrics'].sort());

    assert.throws(() => parseArgs(['snap', '--json']), /--json not supported by tally snap/);
    assert.throws(() => parseArgs(['diff', '--md']), /--md not supported by tally diff/);
    assert.throws(() => parseArgs(['tools', '--brief']), /--brief not supported by tally tools/);
    assert.throws(() => parseArgs(['hooks', '--suggest', '--cost']), /--cost not supported by tally hooks/);
  } finally {
    delete process.env.TALLY_HOME;
  }
});

test('poolpool: usage merge collapses to one row per project, opt-in only', async () => {
  // real /usage shape (verified against ~/git/poolpool/src/api.ts): camelCase, already
  // Number()-converted, grouped by (project, type, profile) — collapse to per-project.
  const rows = mapPoolpoolRows([
    { project: 'aigen', type: 'sync', profile: 'a', totalJobs: 3, completed: 3, failed: 0, inputTokens: 1000, outputTokens: 200, durationMs: 500 },
    { project: 'aigen', type: 'async', profile: 'b', totalJobs: 1, completed: 1, failed: 0, inputTokens: 100, outputTokens: 50, durationMs: 100 },
  ]);
  assert.deepEqual(rows, [{ project: 'aigen', jobs: 4, input: 1100, output: 250 }]);

  const s = await scan({ dir: FIX, since: 0 });
  const r = analyze(s, 0, Date.parse('2026-08-16T00:00:00Z'));
  assert.match(renderText(r, { top: 3, poolpool: rows }), /poolpool/);
  assert.ok(!renderText(r, { top: 3 }).includes('poolpool'), 'no --poolpool flag → no fetch, no table');
});

test('hook ctx-guard: nags once, throttles, never blocks', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tally-ctxhome-'));
  const transcript = join(FIX, '-Users-x-git-demo', 's2.jsonl');
  const env = { TALLY_CTX_LIMIT: '150000', TALLY_HOME: home };
  const input = { session_id: 'x', transcript_path: transcript, hook_event_name: 'PreToolUse' };

  const r1 = runHook('ctx-guard', input, env);
  assert.equal(r1.exit, 0);
  const out1 = JSON.parse(r1.stdout);
  assert.match(out1.hookSpecificOutput.additionalContext, /ctx ~400k/);

  assert.equal(runHook('ctx-guard', input, env).stdout, '', 'throttled immediately after');
  assert.equal(runHook('ctx-guard', input, { ...env, TALLY_CTX_LIMIT: '1000000' }).stdout, '', 'under the limit → silent');

  const missing = runHook('ctx-guard', { ...input, transcript_path: join(FIX, 'does-not-exist.jsonl') }, env);
  assert.equal(missing.exit, 0);
  assert.equal(missing.stdout, '', 'unreadable transcript never blocks');
});

test('hook ctx-guard: ignores a trailing sidechain (subagent) record, same convention as scan.ts', async () => {
  // s1.jsonl's last record is a sidechain turn (cache_read_input_tokens 5000); every main-loop
  // turn before it is 50000 — same fixture the "sidechain excluded from ctx series" scan test uses.
  const home = await mkdtemp(join(tmpdir(), 'tally-ctxhome-'));
  const transcript = join(FIX, '-Users-x-git-demo', 's1.jsonl');
  const env = { TALLY_CTX_LIMIT: '10000', TALLY_HOME: home };
  const r = runHook('ctx-guard', { session_id: 's1x', transcript_path: transcript, hook_event_name: 'PreToolUse' }, env);
  assert.equal(r.exit, 0);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /ctx ~50k/, 'must use the last MAIN-loop record (50k), not the trailing sidechain one (5k)');
});

test('hook pre-bash: rewrite when mechanical, block otherwise', async () => {
  const binDir = await mkdtemp(join(tmpdir(), 'tally-bin-'));
  writeFileSync(join(binDir, 'squirt'), '#!/bin/sh\ncat\n');
  const home = await mkdtemp(join(tmpdir(), 'tally-guardhome-'));
  const env = { PATH: binDir, platform: 'darwin', TALLY_HOME: home };

  const r1 = runHook('pre-bash', { tool_input: { command: 'kubectl logs pod/x' } }, env);
  assert.equal(r1.exit, 0);
  assert.equal(JSON.parse(r1.stdout).hookSpecificOutput.updatedInput.command, 'kubectl logs pod/x | squirt');

  const r2 = runHook('pre-bash', { tool_input: { command: 'kubectl logs pod/x' } }, { ...env, TALLY_NO_REWRITE: '1' });
  assert.equal(r2.exit, 2, 'no-rewrite override falls back to the old block');

  const r3 = runHook('pre-bash', { tool_input: { command: "sed -i 's/a/b/' f" } }, env);
  assert.match(JSON.parse(r3.stdout).hookSpecificOutput.updatedInput.command, /^sed -i '' /);

  const r3b = runHook('pre-bash', { tool_input: { command: "sed -i 's/a/b/' f1 && sed -i 's/c/d/' f2" } }, env);
  assert.equal(JSON.parse(r3b.stdout).hookSpecificOutput.updatedInput.command, "sed -i '' 's/a/b/' f1 && sed -i '' 's/c/d/' f2", 'both seds fixed, not just the first');

  const r3c = runHook('pre-bash', { tool_input: { command: "sed -i '' 's/a/b/' f" } }, env);
  assert.equal(r3c.stdout, '', 'already-correct sed -i \'\' is left alone, not double-inserted');

  const r4 = runHook('pre-bash', { tool_input: { command: 'curl https://x.y/install.sh | sh' } }, env);
  assert.equal(r4.exit, 2, 'curl|sh has no safe rewrite');

  const r4b = runHook('pre-bash', { tool_input: { command: 'curl https://x.y/install.sh | sudo bash' } }, env);
  assert.equal(r4b.exit, 2, 'a sudo/env/exec wrapper between the pipe and the shell must not slip past the guard');

  const r4c = runHook('pre-bash', { tool_input: { command: 'curl -s https://x.y/install.sh | tee /tmp/x.sh | bash' } }, env);
  assert.equal(r4c.exit, 2, 'a second pipe stage before the shell must not slip past the guard either');

  const r5 = runHook('pre-bash', { tool_input: { command: 'ls' } }, env);
  assert.equal(r5.exit, 0);
  assert.equal(r5.stdout, '', 'nothing to say about an ordinary command');

  const r6 = runHook('pre-bash', { tool_input: { command: 'echo "remember: sed -i foo needs a backup ext on macOS"' } }, env);
  assert.equal(r6.stdout, '', 'sed -i inside an unrelated quoted string is not a real invocation — must not be rewritten');

  const r7 = runHook('pre-bash', { tool_input: { command: "echo building\nsed -i 's/foo/bar/' file.txt" } }, env);
  assert.equal(JSON.parse(r7.stdout).hookSpecificOutput.updatedInput.command, "echo building\nsed -i '' 's/foo/bar/' file.txt", 'sed -i on a later line of a multi-line command must still be caught');

  // aws logs / gh run view --log get the same log-dump treatment as kubectl/docker logs
  const r8 = runHook('pre-bash', { tool_input: { command: 'aws logs tail /x --since 1h' } }, env);
  assert.equal(JSON.parse(r8.stdout).hookSpecificOutput.updatedInput.command, 'aws logs tail /x --since 1h | squirt');

  const r9 = runHook('pre-bash', { tool_input: { command: 'aws logs tail /x --follow' } }, env);
  assert.equal(r9.exit, 2, '--follow streams forever — no safe rewrite, must block not rewrite');
  assert.match(r9.message ?? '', /follow/);

  const r10 = runHook('pre-bash', { tool_input: { command: 'aws logs get-log-events --log-group-name /x --log-stream-name y' } }, env);
  assert.equal(JSON.parse(r10.stdout).hookSpecificOutput.updatedInput.command, 'aws logs get-log-events --log-group-name /x --log-stream-name y | squirt', 'get-log-events has no --follow flag, so it always rewrites');

  const r11 = runHook('pre-bash', { tool_input: { command: 'gh run view --log 123456' } }, env);
  assert.equal(JSON.parse(r11.stdout).hookSpecificOutput.updatedInput.command, 'gh run view --log 123456 | squirt');

  const guardLog = await readFile(join(home, 'guard.log'), 'utf8');
  const rows = parseGuardLog(guardLog).sort((a, b) => (a.rule + a.outcome).localeCompare(b.rule + b.outcome));
  assert.deepEqual(
    rows,
    [{ rule: 'pre-bash', outcome: 'blocked', count: 5 }, { rule: 'pre-bash', outcome: 'rewritten', count: 7 }],
    'r2 + r4 + r4b + r4c + r9 blocked, r1 + r3 + r3b + r7 + r8 + r10 + r11 rewritten — r3c/r5/r6 (no-ops) leave no trace',
  );
});

test('hook pre-read: caps an unbounded long-file read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tally-read-'));
  const bigFile = join(dir, 'big.txt');
  writeFileSync(bigFile, 'line\n'.repeat(400));
  const home = await mkdtemp(join(tmpdir(), 'tally-guardhome-'));

  const r1 = runHook('pre-read', { tool_input: { file_path: bigFile } }, { TALLY_HOME: home });
  assert.equal(r1.exit, 0);
  assert.equal(JSON.parse(r1.stdout).hookSpecificOutput.updatedInput.limit, 300);

  assert.equal(runHook('pre-read', { tool_input: { file_path: bigFile, limit: 50 } }, { TALLY_HOME: home }).stdout, '', 'limit already set → no-op');

  const r3 = runHook('pre-read', { tool_input: { file_path: bigFile } }, { TALLY_NO_REWRITE: '1', TALLY_HOME: home });
  assert.equal(r3.exit, 2);

  const r4 = runHook('pre-read', { tool_input: { file_path: bigFile, offset: 50 } }, { TALLY_HOME: home });
  assert.equal(JSON.parse(r4.stdout).hookSpecificOutput.updatedInput.limit, 300, 'offset alone does not bound the read — the guard must still apply');
});

test('hook post-tool: nudges on a big result, silent otherwise, never blocks', () => {
  const r1 = runHook('post-tool', { tool_name: 'Bash', tool_response: { stdout: 'x'.repeat(9000) } });
  assert.equal(r1.exit, 0);
  assert.match(JSON.parse(r1.stdout).hookSpecificOutput.additionalContext, /~2\.3k tok/);

  const r2 = runHook('post-tool', { tool_name: 'Bash', tool_response: { stdout: 'x'.repeat(100) } });
  assert.equal(r2.stdout, '');
});

test('mergeHooks: idempotent merge, preserves unrelated hooks, wires ctx-guard/pre-bash/pre-read/post-tool/post-bash-mark/stop-feedback', () => {
  const first = mergeHooks(undefined);
  assert.equal(first.changed, true);
  const parsed = JSON.parse(first.text);
  assert.equal(parsed.hooks.PreToolUse.length, 3, 'Bash, Read, .* (ctx-guard)');
  assert.ok(parsed.hooks.PreToolUse.some((g: any) => g.matcher === 'Bash' && g.hooks[0].command.includes('tally hook pre-bash')));
  assert.ok(parsed.hooks.PreToolUse.some((g: any) => g.matcher === '.*' && g.hooks[0].command.includes('tally hook ctx-guard')));
  assert.equal(parsed.hooks.PostToolUse.length, 2, '.* (post-tool) and Bash (post-bash-mark)');
  assert.ok(parsed.hooks.PostToolUse.some((g: any) => g.matcher === '.*' && g.hooks[0].command.includes('tally hook post-tool')));
  assert.ok(parsed.hooks.PostToolUse.some((g: any) => g.matcher === 'Bash' && g.hooks[0].command.includes('tally hook post-bash-mark')));
  assert.equal(parsed.hooks.UserPromptSubmit[0].hooks[0].command.includes('tally hook ctx-guard'), true);
  assert.equal(parsed.hooks.Stop[0].hooks[0].command.includes('tally hook stop-feedback'), true);

  const second = mergeHooks(first.text);
  assert.equal(second.changed, false, 'applying twice is a no-op');
  assert.equal(second.text, first.text);

  const withExisting = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'my-other-guard' }] }] } });
  const merged = mergeHooks(withExisting);
  const writeGroup = JSON.parse(merged.text).hooks.PreToolUse.find((g: any) => g.matcher === 'Write');
  assert.equal(writeGroup.hooks[0].command, 'my-other-guard', 'unrelated existing hook preserved verbatim');

  // hand-corrupted settings.json (hooks.PreToolUse is not an array) must not crash the merge
  const malformed = JSON.stringify({ hooks: { PreToolUse: {} } });
  const recovered = mergeHooks(malformed);
  assert.equal(JSON.parse(recovered.text).hooks.PreToolUse.length, 3);
});

test('hook post-bash-mark + stop-feedback: FEEDBACK.md enforcement, never loops on its own re-invocation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tally-fbhome-'));
  const gitDir = await mkdtemp(join(tmpdir(), 'tally-fbgit-'));
  await mkdir(join(gitDir, 'squirt'), { recursive: true });
  const env = { TALLY_HOME: home, TALLY_GIT: gitDir };

  const mark = runHook('post-bash-mark', { session_id: 'abc', cwd: '/x/git/other', tool_input: { command: 'cat a.log | squirt' } }, env);
  assert.equal(mark.exit, 0);
  const marksFile = JSON.parse(await readFile(join(home, 'marks', 'abc'), 'utf8'));
  assert.deepEqual(marksFile.tools, ['squirt']);

  // used from inside squirt's own repo — not a dogfood signal, must not mark
  const own = runHook('post-bash-mark', { session_id: 'own-repo', cwd: join(gitDir, 'squirt'), tool_input: { command: 'squirt x.log' } }, env);
  assert.equal(own.exit, 0);
  assert.equal(runHook('stop-feedback', { session_id: 'own-repo' }, env).exit, 0, 'nothing was ever marked for this session');

  // a SUBDIRECTORY of squirt's own repo must also be excluded, not just the exact root
  const ownSubdir = runHook('post-bash-mark', { session_id: 'own-subdir', cwd: join(gitDir, 'squirt', 'src'), tool_input: { command: 'squirt x.log' } }, env);
  assert.equal(ownSubdir.exit, 0);
  assert.equal(runHook('stop-feedback', { session_id: 'own-subdir' }, env).exit, 0, 'a subdirectory of the tool\'s own repo is not "used elsewhere" either');

  const noFeedbackYet = runHook('stop-feedback', { session_id: 'abc' }, env);
  assert.equal(noFeedbackYet.exit, 2, 'no FEEDBACK.md at all — definitely untouched');
  assert.match(noFeedbackYet.message ?? '', /FEEDBACK\.md/);

  const past = new Date(Date.now() - 60_000);
  await writeFile(join(gitDir, 'squirt', 'FEEDBACK.md'), 'stale');
  await utimes(join(gitDir, 'squirt', 'FEEDBACK.md'), past, past);
  assert.equal(runHook('stop-feedback', { session_id: 'abc' }, env).exit, 2, 'older than the mark — still untouched this session');

  await writeFile(join(gitDir, 'squirt', 'FEEDBACK.md'), 'updated'); // fresh mtime, after the mark
  assert.equal(runHook('stop-feedback', { session_id: 'abc' }, env).exit, 0);

  assert.equal(runHook('stop-feedback', { session_id: 'abc', stop_hook_active: true }, env).exit, 0, 'never re-block its own re-invocation');
  assert.equal(runHook('stop-feedback', { session_id: 'never-marked' }, env).exit, 0, 'no mark file for the session → exit 0');
});

test('renderJson includes fetched poolpool rows (text/md already do)', async () => {
  const s = await scan({ dir: FIX, since: 0 });
  const r = analyze(s, 0, Date.parse('2026-08-16T00:00:00Z'));
  const rows = [{ project: 'aigen', jobs: 4, input: 1100, output: 250 }];
  const withPoolpool = JSON.parse(renderJson(r, 3, undefined, rows));
  assert.deepEqual(withPoolpool.poolpool, rows);
  const without = JSON.parse(renderJson(r, 3));
  assert.equal(without.poolpool, undefined);
});

test('cmdHooks: --print never writes, --install is idempotent, both scoped to root (never a real home dir)', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'tally-hooksroot-'));

  const printed = await cmdHooks({ print: true, root: tmp });
  assert.match(printed.stdout, /tally hook pre-bash/);
  await assert.rejects(readFile(join(tmp, '.claude', 'settings.json'), 'utf8'), '--print must not create .claude/');

  let squirtRuns = 0;
  const env = { PATH: join(tmp, 'bin') }; // fake squirt on PATH — the injected runner must be used, never a real spawn
  await mkdir(join(tmp, 'bin'));
  await writeFile(join(tmp, 'bin', 'squirt'), '');
  const runSquirtInit = () => { squirtRuns++; return 'squirt init: ok'; };
  const installed = await cmdHooks({ install: true, root: tmp, runSquirtInit }, env);
  assert.equal(installed.exit, 0);
  assert.match(installed.message, /wired \d+ hooks into/);
  assert.equal(squirtRuns, 1, 'fresh HOME → squirt init delegated exactly once');
  assert.match(installed.message, /squirt init: ok/);
  const written = JSON.parse(await readFile(join(tmp, '.claude', 'settings.json'), 'utf8'));
  assert.equal(written.hooks.PreToolUse.length, 3);
  assert.equal((await readdir(join(tmp, '.claude'))).some((f) => f.startsWith('settings.json.bak')), false, 'no backup when there was no file to back up');

  const again = await cmdHooks({ install: true, root: tmp, runSquirtInit }, env);
  assert.match(again.message, /already has tally's hooks/);
  assert.equal(squirtRuns, 2, 'still no squirt hook wired (runner is a stub) → asked again');

  // an existing squirt-guard hook → squirt is left alone, runner NOT called
  const withSquirt = JSON.parse(await readFile(join(tmp, '.claude', 'settings.json'), 'utf8'));
  withSquirt.hooks.PreToolUse[0].hooks.unshift({ type: 'command', command: '~/.claude/hooks/squirt-guard.sh' });
  await writeFile(join(tmp, '.claude', 'settings.json'), JSON.stringify(withSquirt));
  const third = await cmdHooks({ install: true, root: tmp, runSquirtInit }, env);
  assert.equal(squirtRuns, 2, 'squirt-guard already wired → runner not called');
  assert.match(third.message, /squirt guard managed by squirt init — left alone/);
  // without squirt on PATH: no squirt note at all
  const noSquirt = await cmdHooks({ install: true, root: tmp, runSquirtInit }, { PATH: '/nonexistent' });
  assert.doesNotMatch(noSquirt.message, /squirt/);
});

test('cmdHooks --install: absorbs the hand-written curl|sh + sed-guard.sh hooks pre-bash covers, keeps squirt-guard + everything else, backs up, second run no-op', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'tally-hooksabsorb-'));
  await mkdir(join(tmp, '.claude'), { recursive: true });
  const sample = await readFile(join(FIX, 'settings.sample.json'), 'utf8');
  await writeFile(join(tmp, '.claude', 'settings.json'), sample);
  const now = new Date(2026, 7, 17);

  const r = await cmdHooks({ install: true, root: tmp, now }, { PATH: '/nonexistent' });
  assert.equal(r.exit, 0);
  assert.match(r.message, /absorbed: inline curl\|sh guard/);
  assert.match(r.message, /absorbed: .*sed-guard\.sh/);
  const text = await readFile(join(tmp, '.claude', 'settings.json'), 'utf8');
  const written = JSON.parse(text);
  const cmds = written.hooks.PreToolUse.flatMap((g: any) => g.hooks.map((h: any) => h.command));
  assert.equal(cmds.some((c: string) => /curl/.test(c) && !/tally hook/.test(c)), false, 'inline curl|sh guard gone');
  assert.equal(cmds.some((c: string) => /sed-guard\.sh/.test(c)), false, 'sed-guard.sh gone');
  assert.ok(cmds.includes('~/.claude/hooks/squirt-guard.sh'), 'squirt-guard kept');
  assert.equal(cmds.filter((c: string) => /tally hook/.test(c)).length, 3, 'pre-bash, pre-read, ctx-guard under PreToolUse');
  assert.equal(listHooks(text, join(tmp, '.claude', 'hooks')).filter((h) => h.origin === 'tally').length, 7, 'tally 7 present');
  const original = JSON.parse(sample);
  for (const k of ['env', 'permissions', 'model']) assert.deepEqual(written[k], original[k], `top-level ${k} preserved`);
  assert.equal(await readFile(join(tmp, '.claude', 'settings.json.bak-tally-install-20260817'), 'utf8'), sample, 'backup = the file as it was');

  const again = await cmdHooks({ install: true, root: tmp, now }, { PATH: '/nonexistent' });
  assert.match(again.message, /nothing to change/);
  assert.doesNotMatch(again.message, /absorbed/);
  assert.equal(await readFile(join(tmp, '.claude', 'settings.json'), 'utf8'), text, 'second run byte-identical');

  // --keep-legacy: nothing absorbed
  const tmp2 = await mkdtemp(join(tmpdir(), 'tally-hookskeep-'));
  await mkdir(join(tmp2, '.claude'), { recursive: true });
  await writeFile(join(tmp2, '.claude', 'settings.json'), sample);
  const kept = await cmdHooks({ install: true, root: tmp2, keepLegacy: true }, { PATH: '/nonexistent' });
  assert.doesNotMatch(kept.message, /absorbed/);
  const keptCmds = JSON.parse(await readFile(join(tmp2, '.claude', 'settings.json'), 'utf8')).hooks.PreToolUse.flatMap((g: any) => g.hooks.map((h: any) => h.command));
  assert.ok(keptCmds.some((c: string) => /sed-guard\.sh/.test(c)), '--keep-legacy leaves sed-guard.sh');
});

test('cmdHooks --install: no-op write — hand-formatted 4-space JSON already holding tally\'s hooks stays byte-identical', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'tally-hooksnoop-'));
  await mkdir(join(tmp, '.claude'), { recursive: true });
  const fourSpace = JSON.stringify(JSON.parse(mergeHooks(JSON.stringify({ model: 'opusplan' })).text), null, 4); // no trailing newline either
  await writeFile(join(tmp, '.claude', 'settings.json'), fourSpace);
  const r = await cmdHooks({ install: true, root: tmp }, { PATH: '/nonexistent' });
  assert.match(r.message, /nothing to change/);
  assert.equal(await readFile(join(tmp, '.claude', 'settings.json'), 'utf8'), fourSpace, 'not rewritten');
  assert.deepEqual((await readdir(join(tmp, '.claude'))).filter((f) => f.startsWith('settings.json.bak')), [], 'no backup on a no-op');
});

test('listHooks: tags each configured hook with its origin (tally / script-in-hooksDir / squirt / inline)', async () => {
  const text = await readFile(join(FIX, 'settings.sample.json'), 'utf8');
  assert.deepEqual(listHooks(text, '~/.claude/hooks').map((r) => r.origin), ['inline', '~/.claude/hooks/squirt-guard.sh', '~/.claude/hooks/sed-guard.sh', 'tally']);
  assert.deepEqual(listHooks(undefined, '~/.claude/hooks'), []);
  // a squirt reference NOT living under hooksDir still gets the generic 'squirt' label
  const squirtInit = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'squirt init --claude --global' }] }] } });
  assert.deepEqual(listHooks(squirtInit, '~/.claude/hooks').map((r) => r.origin), ['squirt']);
});

test('findDuplicateHooks / renderHooksList: flags two rewriters wired on the same event+matcher', async () => {
  // realistic post-`--install` state (item #85): squirt-guard.sh kept (never absorbed) sitting
  // right next to tally's own pre-bash, both rewriting log-dump commands to `| squirt`
  const bothWired = JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: '~/.claude/hooks/squirt-guard.sh' },
            { type: 'command', command: 'command -v tally >/dev/null 2>&1 || exit 0; tally hook pre-bash' },
          ],
        },
      ],
    },
  });
  const rows = listHooks(bothWired, '~/.claude/hooks');
  assert.deepEqual(rows.map((r) => r.origin), ['~/.claude/hooks/squirt-guard.sh', 'tally']);
  assert.deepEqual(findDuplicateHooks(rows), ['⚠ duplicate: squirt-guard.sh ~ pre-bash (same job — PreToolUse/Bash)']);
  assert.match(renderHooksList(rows), /⚠ duplicate: squirt-guard\.sh ~ pre-bash \(same job — PreToolUse\/Bash\)$/);

  // one guard alone (or paired only with 'inline' hooks) is not a duplicate
  const sample = await readFile(join(FIX, 'settings.sample.json'), 'utf8'); // inline curl|sh + squirt-guard.sh + sed-guard.sh + tally, all on PreToolUse/Bash
  assert.equal(findDuplicateHooks(listHooks('{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"~/.claude/hooks/squirt-guard.sh"}]}]}}', '~/.claude/hooks')).length, 0, 'a single non-inline origin is never a duplicate');
  assert.ok(findDuplicateHooks(listHooks(sample, '~/.claude/hooks')).length >= 1, 'settings.sample.json already mixes 3 non-inline origins (squirt-guard.sh, sed-guard.sh, tally) on PreToolUse/Bash — also a real duplicate set, per the generalized ≥2-non-inline-origins heuristic');
});

test('cmdHooks --list: renders every configured hook + origin, never writes', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'tally-hookslist-'));
  await mkdir(join(tmp, '.claude'), { recursive: true });
  const sample = await readFile(join(FIX, 'settings.sample.json'), 'utf8');
  await writeFile(join(tmp, '.claude', 'settings.json'), sample);

  const listed = await cmdHooks({ list: true, root: tmp, hooksDir: '~/.claude/hooks' }); // literal tilde, like the real settings.json — never expanded, never a real dir
  assert.equal(listed.exit, 0);
  assert.match(listed.stdout, /tally/);
  assert.match(listed.stdout, /squirt-guard\.sh/);
  assert.match(listed.stdout, /inline/);
  assert.match(listed.stdout.split('\n')[0], /command\s+origin$/, 'origin is the last column, full width');
  assert.match(listed.stdout, /squirt-guard\.sh$/m, 'long origin path not capped');
  assert.equal(await readFile(join(tmp, '.claude', 'settings.json'), 'utf8'), sample, '--list must not write');

  const empty = await mkdtemp(join(tmpdir(), 'tally-hookslist-empty-'));
  const none = await cmdHooks({ list: true, root: empty });
  assert.equal(none.stdout, `no local hooks (${empty}) — try --global`);
});

test('parseArgs hooks --suggest: print-only, mutually exclusive with --install/--print', () => {
  assert.equal(parseArgs(['hooks', '--suggest']).hooksSuggest, true);
  assert.equal(parseArgs(['hooks', '--list']).hooksList, true);
  assert.equal(parseArgs(['hooks', '--install', '--keep-legacy']).hooksKeepLegacy, true);
  assert.throws(() => parseArgs(['--keep-legacy']), /tally hooks/);
  assert.throws(() => parseArgs(['hooks', '--install', '--print']), /pick one/);
  assert.throws(() => parseArgs(['hooks', '--list', '--install']), /pick one/);
  assert.throws(() => parseArgs(['hooks', '--install', '--suggest']), /pick one/);
  assert.throws(() => parseArgs(['--suggest']), /tally hooks/);
});

test('parseGuardLog groups by rule + outcome', () => {
  const text = '2026-08-17T00:00:00.000Z pre-bash rewritten\n'.repeat(3);
  assert.deepEqual(parseGuardLog(text), [{ rule: 'pre-bash', outcome: 'rewritten', count: 3 }]);
});

test('skillsReport groups Skill calls by skill name × month', () => {
  const base = { id: 'x', sessionId: 's', project: 'p', inputKey: 'k', resultChars: 0, resultLines: 0, isError: false, isDenied: false, isSidechain: false };
  const calls = [
    { ...base, id: 'a', name: 'Skill', input: { skill: 'start' }, timestamp: Date.parse('2026-08-01T00:00:00Z') },
    { ...base, id: 'b', name: 'Skill', input: { skill: 'start' }, timestamp: Date.parse('2026-08-15T00:00:00Z') },
    { ...base, id: 'c', name: 'Bash', input: { command: 'ls' }, timestamp: Date.parse('2026-08-01T00:00:00Z') },
  ];
  assert.deepEqual(skillsReport(calls), [{ skill: 'start', month: '2026-08', calls: 2 }]);
});

test('toolsReport: excludes calls from the tool\'s own repo, flags < 5/month', () => {
  const base = { id: 'x', sessionId: 's', inputKey: 'k', resultChars: 0, resultLines: 0, isError: false, isDenied: false, isSidechain: false };
  const calls = [
    { ...base, id: 'a', name: 'Bash', project: 'git/demo', timestamp: Date.parse('2026-08-15T10:00:00Z'), input: { command: 'cat x.log | squirt --level warn' } },
    { ...base, id: 'b', name: 'Bash', project: 'git/squirt', timestamp: Date.parse('2026-08-15T10:00:00Z'), input: { command: 'squirt x.log' } },
  ];
  assert.deepEqual(toolsReport(calls, ['squirt']), [{ tool: 'squirt', month: '2026-08', calls: 1, projects: 1, flag: true }]);

  // with a raw cwd recorded, a SUBDIRECTORY of the tool's own repo is excluded too — project
  // alone (last-two-path-segments) can't tell "git/squirt/src" apart from an unrelated repo
  const withCwd = [
    { ...base, id: 'c', name: 'Bash', project: 'squirt/src', cwd: '/Users/x/git/squirt/src', timestamp: Date.parse('2026-08-15T10:00:00Z'), input: { command: 'squirt x.log' } },
    { ...base, id: 'd', name: 'Bash', project: 'demo/deep', cwd: '/Users/x/git/demo/deep', timestamp: Date.parse('2026-08-15T10:00:00Z'), input: { command: 'squirt x.log' } },
  ];
  assert.deepEqual(
    toolsReport(withCwd, ['squirt'], '/Users/x/git'),
    [{ tool: 'squirt', month: '2026-08', calls: 1, projects: 1, flag: true }],
    'call c excluded (inside squirt/src), call d counted (unrelated repo)',
  );
});

test('renderBrief: ≤ 12 lines, heaviest + top leaks, --brief CLI wiring', async () => {
  const s = await scan({ dir: FIX, since: 0 });
  const r = analyze(s, 0, Date.parse('2026-08-16T00:00:00Z'));
  const brief = renderBrief(r);
  assert.ok(brief.split('\n').length <= 12);
  assert.match(brief, /long-context/);
  assert.match(brief, /s2\s+git\/demo/);

  assert.match(brief, /^tally — all · /, '--since all (since 0) → "all", not a 20682d window');
  assert.match(renderText(r, { top: 3 }), /^tally — all window/);
  assert.equal(parseArgs(['--brief']).brief, true);
  assert.throws(() => parseArgs(['--brief', '--json']), /pick one/);
});

test('parseTokenCount', () => {
  assert.equal(parseTokenCount('150k'), 150_000);
  assert.equal(parseTokenCount('200000'), 200_000);
  assert.equal(parseTokenCount('1M'), 1_000_000);
  assert.throws(() => parseTokenCount('lots'));
});

test('incremental parser matches batch parse', async () => {
  const path = join(FIX, '-Users-x-git-demo', 's1.jsonl');
  const batch = await parseTranscript(path, '-Users-x-git-demo');
  const p = new TranscriptParser('-Users-x-git-demo');
  let turnEvents = 0;
  let completed = 0;
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const ev = p.push(line);
    if (ev.turn) turnEvents++;
    completed += ev.completed.length;
  }
  assert.deepEqual(p.turns, batch.turns);
  assert.deepEqual(p.calls, batch.calls);
  assert.equal(turnEvents, 5, 'one turn event per requestId (incl. sidechain)');
  assert.equal(completed, 5);
  assert.ok(p.calls.every((c) => typeof c.completedTs === 'number'), 'spans get completion timestamps');
});

test('describe names files not raw JSON', () => {
  const base = { id: 'x', sessionId: 's', project: 'p', timestamp: 0, inputKey: 'k', resultChars: 0, resultLines: 0, isError: false, isDenied: false, isSidechain: false };
  assert.equal(describeCall({ ...base, name: 'Edit', input: { file_path: '/a/b.ts', old_string: 'xxxx' } }), 'Edit: /a/b.ts');
  assert.equal(describeCall({ ...base, name: 'Write', input: { file_path: '/a/c.md', content: 'yyyy' } }), 'Write: /a/c.md');
  assert.equal(describeCall({ ...base, name: 'WebFetch', input: { url: 'https://x.y/z' } }), 'WebFetch: https://x.y/z');
  assert.equal(describeCall({ ...base, name: 'WebSearch', input: { query: 'foo bar' } }), 'WebSearch: foo bar');
});

test('classifyCall buckets', () => {
  const base = { id: 'x', sessionId: 's', project: 'p', timestamp: 0, input: {}, inputKey: 'k', resultChars: 0, resultLines: 0, isError: false, isDenied: false, isSidechain: false };
  assert.equal(classifyCall({ ...base, name: 'Bash', isError: true }), 'error');
  assert.equal(classifyCall({ ...base, name: 'Bash', isError: true, isDenied: true }), 'denied', 'denied wins over error');
  assert.equal(classifyCall({ ...base, name: 'Bash', input: { command: 'kubectl logs pod/x' } }), 'log-dump');
  assert.equal(classifyCall({ ...base, name: 'Read', resultLines: 400, resultChars: 100 }), 'read-full-file');
  assert.equal(classifyCall({ ...base, name: 'Bash', resultChars: 50_000 }), 'huge');
  assert.equal(classifyCall({ ...base, name: 'Bash', resultChars: 9_000 }), 'big');
  assert.equal(classifyCall({ ...base, name: 'Grep', resultChars: 10 }), null);
});

test('trace: session pick + turn lines + threshold warnings', async () => {
  const found = await findTranscript({ dir: FIX, session: 's2' });
  assert.ok(found?.path.endsWith('s2.jsonl'));
  const lines: string[] = [];
  const code = await runTrace({ dir: FIX, session: 's2', follow: false, ctxLimit: 150_000 }, (l) => lines.push(l));
  assert.equal(code, 0);
  const txt = lines.join('\n');
  assert.equal(lines.filter((l) => /^t\d+ /.test(l)).length, 6, 'one line per turn');
  assert.match(txt, /^t1 {4}\d\d:\d\d:\d\d {2}ctx {4}50k {4}\+50k {2}out {3}100/m);
  assert.match(txt, /⚠ ctx crossed 150k at turn 3 — \/compact or new session/);
  assert.match(txt, /⚠ ctx crossed 300k \(2× limit\) at turn 5/);
  assert.match(txt, /— 6 turns · peak ctx 400k · crossed 150k t3 · burned above 150k ~550k/);
});

test('projectLabel', () => {
  assert.equal(projectLabel('-Users-x-git-squirt'), 'git/squirt');
  assert.equal(projectLabel('-x', '/Users/x/Documents/Notes'), 'Documents/Notes');
});

test('inputKey stable', () => {
  assert.equal(inputKey('Read', { a: 1 }), inputKey('Read', { a: 1 }));
  assert.notEqual(inputKey('Read', { a: 1 }), inputKey('Read', { a: 2 }));
});

test('usedTools: command-position only — flags, paths, cd targets and plain words are not usage', () => {
  const T = ['looksy', 'peep', 'squirt', 'tally', 'snuff', 'brief'];
  assert.deepEqual(usedTools('pulse --brief', T), []);
  assert.deepEqual(usedTools('tally --brief', T), ['tally']);
  assert.deepEqual(usedTools('cd ~/git/brief && npm test', T), []);
  assert.deepEqual(usedTools('kubectl logs x | squirt --level warn', T), ['squirt']);
  assert.deepEqual(usedTools('FOO=1 peep check x', T), ['peep']);
  assert.deepEqual(usedTools('node ~/git/looksy/bin/looksy.js shot', T), ['looksy']);
  assert.deepEqual(usedTools('echo brief', T), []);
  assert.deepEqual(usedTools('ls ~/git/looksy/src', T), []);
  assert.deepEqual(usedTools('npx snuff; (brief --hub)', T), ['snuff', 'brief']);
  assert.deepEqual(usedTools('cat a.log 2>&1 | squirt || tally', T), ['squirt', 'tally']);
  assert.deepEqual(usedTools('OUT=$(brief --json)', T), ['brief']);
  // quoted `\|` (grep BRE alternation) must not be treated as a shell pipe separator
  assert.deepEqual(usedTools('grep -n "squirt-guard\\|squirt init" file.md | head -20', T), []);
});

test('bashLooksLikeLogDump: quote/heredoc-aware — prose describing a log command is not an invocation', () => {
  assert.equal(bashLooksLikeLogDump('kubectl logs mypod -n prod'), true);
  assert.equal(bashLooksLikeLogDump('aws logs tail /ecs/foo --since 1h'), true);
  assert.equal(bashLooksLikeLogDump('kubectl logs x | squirt'), false);
  // a commit message heredoc describing the guard's own coverage in prose must not trip the guard
  const commitCmd = `git commit -m "$(cat <<'EOF'\npre-bash: cover CloudWatch/Actions log-tail commands\n\nThis session's own #81 work: aws logs tail, docker logs, gh run view --log\nEOF\n)"`;
  assert.equal(bashLooksLikeLogDump(commitCmd), false);
  // single-quoted commit message with the same prose
  assert.equal(bashLooksLikeLogDump(`git commit -m 'mentions aws logs tail and docker logs as prose'`), false);
  // real invocation still caught even alongside an unrelated quoted string
  assert.equal(bashLooksLikeLogDump(`echo "note" && kubectl logs mypod`), true);
});
