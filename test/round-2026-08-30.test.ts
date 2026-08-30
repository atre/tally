// Acceptance tests for plans/2026-08-30-feedback-round.md — failing at authoring time by design.
// Do not edit these while executing the plan; the plan is done when they pass unmodified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { scan } from '../src/scan.js';
import { analyze } from '../src/analyze.js';
import { renderJson, renderText } from '../src/render.js';
import { runHook, cmdHooks } from '../src/hooks.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures');
const lines = (n: number, text = 'line') => `${text}\n`.repeat(n);
const ctxOf = (r: { stdout: string }) => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : undefined);

async function guardEnv() {
  const binDir = await mkdtemp(join(tmpdir(), 'tally-bin-'));
  writeFileSync(join(binDir, 'squirt'), '#!/bin/sh\ncat\n'); // squirtOnPath only checks existence
  const home = await mkdtemp(join(tmpdir(), 'tally-guardhome-'));
  return { PATH: binDir, platform: 'darwin', TALLY_HOME: home };
}

test('item 2: pre-bash skips the squirt wrap for a small or scratchpad file, keeps it for big files and log producers', async () => {
  const env = await guardEnv();
  const dir = await mkdtemp(join(tmpdir(), 'tally-readfiles-'));
  const small = join(dir, 'small.log');
  const big = join(dir, 'big.log');
  await writeFile(small, lines(4, 'AggregateError: '));
  await writeFile(big, lines(400));

  const r1 = runHook('pre-bash', { tool_input: { command: `cat ${small}` } }, env);
  assert.equal(r1.exit, 0);
  assert.equal(r1.stdout, '', '4-line file: no rewrite, nothing to say');

  const r2 = runHook('pre-bash', { tool_input: { command: `cat ${big}` } }, env);
  assert.equal(ctxOf(r2)?.updatedInput?.command, `cat ${big} | squirt`, '400-line .log still wrapped');

  const r3 = runHook('pre-bash', { tool_input: { command: `tail -n 500 ${small}` } }, env);
  assert.equal(r3.stdout, '', 'tail -n 500 of a 4-line file: file reader + small → skip');

  const scratchRoot = await mkdtemp(join(tmpdir(), 'claude-x-'));
  await mkdir(join(scratchRoot, 'sess', 'scratchpad'), { recursive: true });
  const probe = join(scratchRoot, 'sess', 'scratchpad', 'probe.log');
  await writeFile(probe, lines(400));
  const r4 = runHook('pre-bash', { tool_input: { command: `cat ${probe}` } }, env);
  assert.equal(r4.stdout, '', 'a 400-line file under claude-*/…/scratchpad/ is the session\'s own scratch — never wrapped');

  const r5 = runHook('pre-bash', { cwd: dir, tool_input: { command: 'cat small.log' } }, env);
  assert.equal(r5.stdout, '', 'relative path resolves against the hook cwd');

  const r6 = runHook('pre-bash', { tool_input: { command: 'kubectl logs foo' } }, env);
  assert.equal(ctxOf(r6)?.updatedInput?.command, 'kubectl logs foo | squirt', 'log producers are always wrapped');
});

test('item 6: pre-bash nudges (context only) on a bare cat of a >300-line file, silent on slices and pipes', async () => {
  const env = await guardEnv();
  const dir = await mkdtemp(join(tmpdir(), 'tally-catnudge-'));
  const big = join(dir, 'big.txt');
  const ten = join(dir, 'ten.txt');
  await writeFile(big, lines(400));
  await writeFile(ten, lines(10));

  const n1 = runHook('pre-bash', { tool_input: { command: `cat ${big}` } }, env);
  assert.equal(n1.exit, 0);
  assert.match(ctxOf(n1)?.additionalContext ?? '', /400 lines/, 'names the size');
  assert.equal(ctxOf(n1)?.updatedInput, undefined, 'a nudge, never a rewrite');

  assert.equal(runHook('pre-bash', { tool_input: { command: `cat ${big} | grep x` } }, env).stdout, '', 'piped cat is a slice');
  assert.equal(runHook('pre-bash', { tool_input: { command: `sed -n '1,50p' ${big}` } }, env).stdout, '', 'sed -n is the slice idiom');
  assert.equal(runHook('pre-bash', { tool_input: { command: `head -50 ${big}` } }, env).stdout, '', 'head is a slice');
  assert.equal(runHook('pre-bash', { tool_input: { command: `cat ${ten}` } }, env).stdout, '', 'small file: silent');
});

test('item 5: pre-read nudges (context only) when the same file is Read in full twice in one session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tally-readhome-'));
  const dir = await mkdtemp(join(tmpdir(), 'tally-dedup-'));
  const ten = join(dir, 'ten.txt');
  const big = join(dir, 'big.txt');
  await writeFile(ten, lines(10));
  await writeFile(big, lines(400));
  const env = { TALLY_HOME: home };

  assert.equal(runHook('pre-read', { session_id: 'dd1', tool_input: { file_path: ten } }, env).stdout, '', 'first full read: silent');
  const a2 = runHook('pre-read', { session_id: 'dd1', tool_input: { file_path: ten } }, env);
  assert.equal(a2.exit, 0);
  assert.match(ctxOf(a2)?.additionalContext ?? '', /already read in full/);
  assert.equal(ctxOf(a2)?.updatedInput, undefined, 'never a rewrite for a small file');
  assert.equal(runHook('pre-read', { session_id: 'dd1', tool_input: { file_path: ten, limit: 5 } }, env).stdout, '', 'a bounded read is not a repeat');
  assert.equal(runHook('pre-read', { session_id: 'dd2', tool_input: { file_path: ten } }, env).stdout, '', 'another session has its own memory');

  const b1 = runHook('pre-read', { session_id: 'dd1', tool_input: { file_path: big } }, env);
  assert.equal(ctxOf(b1)?.updatedInput?.limit, 300, 'first read of a long file: capped as before');
  assert.equal(ctxOf(b1)?.additionalContext, undefined);
  const b2 = runHook('pre-read', { session_id: 'dd1', tool_input: { file_path: big } }, env);
  assert.equal(ctxOf(b2)?.updatedInput?.limit, 300, 'second read: still capped');
  assert.match(ctxOf(b2)?.additionalContext ?? '', /already read/, '…and told it is a repeat');

  assert.equal(runHook('pre-read', { tool_input: { file_path: ten } }, env).stdout, '', 'no session id → no memory');
  assert.equal(runHook('pre-read', { tool_input: { file_path: ten } }, env).stdout, '', 'no session id → no memory (second call)');
});

test('item 3: a session that started before the --since window is marked partial', async () => {
  const cut = Date.parse('2026-08-15T10:00:02.5Z'); // s1 spans 10:00:00–10:00:04; s5 starts 11:00:00
  const s = await scan({ dir: FIX, since: cut });
  const partialOf = (id: string) => (s.sessions.get(id) as { partial?: boolean } | undefined)?.partial;
  assert.equal(partialOf('s1'), true, 's1 has records before the cut');
  assert.ok(!partialOf('s5'), 's5 started inside the window');

  const r = analyze(s, cut, Date.parse('2026-08-16T00:00:00Z'));
  const row = r.heaviest.find((h) => h.id === 's1') as { partial?: boolean } | undefined;
  assert.equal(row?.partial, true);
  assert.match(renderText(r, { top: 5 }), /s1 .*\(partial, started before window\)/);
  const json = JSON.parse(renderJson(r, 5)) as { heaviest: { id: string; partial?: boolean }[] };
  assert.equal(json.heaviest.find((h) => h.id === 's1')?.partial, true);

  const all = await scan({ dir: FIX, since: 0 });
  assert.equal((all.sessions.get('s1') as { partial?: boolean } | undefined)?.partial, undefined, 'since=0: nothing is partial');
});

test('item 4: marathon finding — >500 turns and never compacted, its own leak bucket', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tally-marathon-'));
  const pdir = join(dir, '-Users-x-git-mara');
  await mkdir(pdir);
  const rec = (sid: string, i: number, ctx: number) =>
    JSON.stringify({
      type: 'assistant',
      requestId: `${sid}-r${i}`,
      sessionId: sid,
      cwd: '/Users/x/git/mara',
      timestamp: new Date(Date.parse('2026-08-15T09:00:00Z') + i * 1000).toISOString(),
      message: { model: 'claude-test', usage: { input_tokens: 0, output_tokens: 10, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0 }, content: [] },
    });
  const m1: string[] = [];
  const m2: string[] = [];
  for (let i = 1; i <= 501; i++) {
    m1.push(rec('m1', i, 80_000)); // never compacts
    m2.push(rec('m2', i, i <= 250 ? 80_000 : 30_000)); // one compaction at turn 251
  }
  await writeFile(join(pdir, 'm1.jsonl'), `${m1.join('\n')}\n`);
  await writeFile(join(pdir, 'm2.jsonl'), `${m2.join('\n')}\n`);

  const r = analyze(await scan({ dir, since: 0 }), 0, Date.parse('2026-08-16T00:00:00Z'));
  const f = r.findings.find((x) => x.key === 'marathon');
  assert.ok(f, 'marathon finding exists');
  assert.equal(f.count, 1, 'm2 compacted once → not a marathon');
  assert.match(f.title, /Marathon/);
  assert.match(f.samples[0], /^m1 /);
  assert.match(f.samples[0], /501 turns/);
  assert.equal(r.findings[0].key, 'marathon', 'no long-context (avg 80k < 150k) and no compact-loop here → first slot');
  assert.match(renderText(r, { top: 5 }), /Marathon/);

  const rf = analyze(await scan({ dir: FIX, since: 0 }), 0, Date.parse('2026-08-16T00:00:00Z'));
  assert.equal(rf.findings.find((x) => x.key === 'marathon'), undefined, 'the fixture has no 500-turn session');
});

test('item 7: hooks --install owns the log guard — a wired squirt-guard.sh is absorbed, squirt init is never consulted', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'tally-hooksown-'));
  await mkdir(join(tmp, '.claude'), { recursive: true });
  const before = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '~/.claude/hooks/squirt-guard.sh' }] }] } };
  await writeFile(join(tmp, '.claude', 'settings.json'), JSON.stringify(before, null, 2));
  const env = await guardEnv(); // fake squirt on PATH — must make no difference any more

  const r = await cmdHooks({ install: true, root: tmp, now: new Date(2026, 7, 30) }, env);
  assert.equal(r.exit, 0);
  assert.match(r.message, /absorbed: .*squirt-guard\.sh/);
  assert.doesNotMatch(r.message, /squirt init|managed by squirt/);
  const written = JSON.parse(await readFile(join(tmp, '.claude', 'settings.json'), 'utf8'));
  const cmds: string[] = written.hooks.PreToolUse.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
  assert.equal(cmds.some((c) => /squirt-guard/.test(c)), false, 'squirt-guard.sh gone');
  assert.equal(cmds.filter((c) => /tally hook/.test(c)).length, 3, 'pre-bash, pre-read, ctx-guard under PreToolUse');

  const kept = await mkdtemp(join(tmpdir(), 'tally-hookskeep-'));
  await mkdir(join(kept, '.claude'), { recursive: true });
  await writeFile(join(kept, '.claude', 'settings.json'), JSON.stringify(before));
  const k = await cmdHooks({ install: true, root: kept, keepLegacy: true }, env);
  assert.doesNotMatch(k.message, /absorbed/);
  const keptCmds: string[] = JSON.parse(await readFile(join(kept, '.claude', 'settings.json'), 'utf8')).hooks.PreToolUse.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
  assert.ok(keptCmds.includes('~/.claude/hooks/squirt-guard.sh'), '--keep-legacy leaves it, like sed-guard.sh');
});

test('item 2b (2026-08-30 aigen S8): pre-bash never wraps a markdown file — tables/prose dedupe into an unreadable digest', async () => {
  const env = await guardEnv();
  const dir = await mkdtemp(join(tmpdir(), 'tally-readmd-'));
  const state = join(dir, 'STATE.md');
  await writeFile(state, lines(400));
  const r1 = runHook('pre-bash', { tool_input: { command: `tail -100 ${state}` } }, env);
  assert.equal(r1.exit, 0);
  assert.equal(r1.stdout, '', '400-line .md: no rewrite, nothing to say');
  const r2 = runHook('pre-bash', { tool_input: { command: `cat ${join(dir, 'NOTES.markdown')}` } }, env);
  assert.equal(r2.stdout, '', 'missing .markdown target: no reader → falls through to the plain-cat path, still no wrap');
});
