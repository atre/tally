// Acceptance tests for plans/2026-08-30-feedback-round-2.md — failing at authoring time by design.
// Do not edit these while executing the plan; the plan is done when they pass unmodified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runHook } from '../src/hooks.js';

const ctxOf = (r: { stdout: string }) => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : undefined);

async function guardEnv() {
  const binDir = await mkdtemp(join(tmpdir(), 'tally-bin-'));
  writeFileSync(join(binDir, 'squirt'), '#!/bin/sh\ncat\n'); // squirtOnPath only checks existence
  const home = await mkdtemp(join(tmpdir(), 'tally-guardhome-'));
  const gitDir = await mkdtemp(join(tmpdir(), 'tally-guardgit-'));
  for (const t of ['squirt', 'brief', 'snuff']) await mkdir(join(gitDir, t), { recursive: true });
  return { PATH: binDir, platform: 'darwin', TALLY_HOME: home, TALLY_GIT: gitDir };
}

// A real field-session command (2026-08-30, paths anonymised): a task-output read that
// pre-bash auto-wrapped with `| squirt`, which post-bash-mark then counted as dogfooding.
const FIELD_CMD = 'F="/private/tmp/claude-501/-Users-u-git-shop/00000000-0000-4000-8000-000000000000/tasks/b6ivggznx.output"\nwc -l "$F"\ntail -100 "$F"';

test('A: post-tool nudges only on a ≥32k-char result or a REPEATED ≥8k-char target in the same session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tally-posttool-'));
  const env = { TALLY_HOME: home };
  const nag = (tool: string, response: unknown, input: Record<string, unknown>, session_id?: string) =>
    runHook('post-tool', { session_id, tool_name: tool, tool_input: input, tool_response: response }, env).stdout;
  const mid = 'x'.repeat(12_000); // ~3k tok: over BIG_RESULT_CHARS, under the new 4× ceiling
  const huge = 'x'.repeat(36_000); // ~9k tok: over the ceiling

  // one whole read of a mid-size file is the deliverable, not a leak
  assert.equal(nag('Read', mid, { file_path: '/x/plan.md' }, 's1'), '', 'first full read of a 3k-tok file: silent');
  const again = nag('Read', mid, { file_path: '/x/plan.md' }, 's1');
  assert.match(again, /~3\.0k tok/, 'second read of the same file: nudged');
  assert.match(again, /trim next time \(squirt \/ head \/ Read limit\)/);
  assert.equal(nag('Read', mid, { file_path: '/x/other.md' }, 's1'), '', 'a different file is not a repeat');
  assert.equal(nag('Read', mid, { file_path: '/x/plan.md' }, 's2'), '', 'another session has its own memory');
  assert.match(nag('Read', huge, { file_path: '/x/big.md' }, 's1'), /~9\.0k tok/, 'a 9k-tok result nudges on first sight');

  // Bash: the key is the command string
  assert.equal(nag('Bash', { stdout: mid, stderr: '', interrupted: false, isImage: false }, { command: 'cat big.txt' }, 's3'), '');
  assert.match(nag('Bash', { stdout: mid, stderr: '', interrupted: false, isImage: false }, { command: 'cat big.txt' }, 's3'), /trim next time/, 'identical command again: nudged');
  assert.equal(nag('Bash', { stdout: mid, stderr: '', interrupted: false, isImage: false }, { command: 'cat other.txt' }, 's3'), '');
  // an explicit loop behaves like any other Bash result now (the 4× ceiling is the general rule)
  const loopCmd = { command: "for f in src/*.ts; do sed -n '2,4p' $f; done" };
  assert.equal(nag('Bash', { stdout: 'y'.repeat(20_000), stderr: '', interrupted: false, isImage: false }, loopCmd, 's4'), '');
  assert.match(nag('Bash', { stdout: 'y'.repeat(40_000), stderr: '', interrupted: false, isImage: false }, loopCmd, 's4'), /trim next time/);

  // no session id → no memory: only the ceiling applies
  assert.equal(nag('Read', mid, { file_path: '/x/plan.md' }), '');
  assert.equal(nag('Read', mid, { file_path: '/x/plan.md' }), '');
  assert.match(nag('Read', huge, { file_path: '/x/plan.md' }), /~9\.0k tok/);

  // small results are never remembered — the memory file only lists big ones
  assert.equal(nag('Read', 'x'.repeat(100), { file_path: '/x/tiny.md' }, 's5'), '');
  assert.equal(nag('Read', 'x'.repeat(100), { file_path: '/x/tiny.md' }, 's5'), '');
  const s1mem = await readFile(join(home, 'results', 's1'), 'utf8');
  assert.equal(s1mem.split('\n').filter(Boolean).length, 3, 'three distinct big targets were seen in s1 (plan.md once — a repeat is not re-appended, other.md, big.md)');

  // WebFetch keeps its own first-time hint (the remedy is "don't re-fetch", which only helps if said the first time)
  assert.match(nag('WebFetch', mid, { url: 'https://x.y' }, 's6'), /re-fetch/);
  // other tools: silent first, sized-only message on repeat
  assert.equal(nag('Grep', mid, { pattern: 'x' }, 's7'), '');
  const grep = nag('Grep', mid, { pattern: 'x' }, 's7');
  assert.match(grep, /~3\.0k tok entered context/);
  assert.ok(!grep.includes('squirt'));
});

test('B1: a `| squirt` injected by pre-bash is not dogfooding — post-bash-mark must not mark it', async () => {
  const env = await guardEnv();
  const pre = runHook('pre-bash', { session_id: 'w1', cwd: '/x/git/other', tool_name: 'Bash', tool_input: { command: FIELD_CMD } }, env);
  const rewritten = ctxOf(pre)?.updatedInput?.command as string | undefined;
  assert.ok(rewritten?.endsWith(' | squirt'), 'precondition: pre-bash still auto-wraps the field command');

  const mark = runHook('post-bash-mark', { session_id: 'w1', cwd: '/x/git/other', tool_name: 'Bash', tool_input: { command: rewritten } }, env);
  assert.equal(mark.exit, 0);
  await assert.rejects(readFile(join(env.TALLY_HOME, 'marks', 'w1'), 'utf8'), 'no marks file: the wrap was tally\'s doing, not the model\'s');
  assert.equal(runHook('stop-feedback', { session_id: 'w1' }, env).exit, 0, 'and Stop is not blocked');

  // the model's OWN squirt call in the same session still marks (the consumed rewrite record does not shadow it)
  runHook('post-bash-mark', { session_id: 'w1', cwd: '/x/git/other', tool_name: 'Bash', tool_input: { command: 'tail -100 app.log | squirt' } }, env);
  const marks = JSON.parse(await readFile(join(env.TALLY_HOME, 'marks', 'w1'), 'utf8'));
  assert.deepEqual(marks.tools, ['squirt']);
  assert.equal(marks.via.squirt, 'tail -100 app.log | squirt');
});

test('B2: mark provenance is the STATEMENT that invoked the tool, not the head of the whole command', async () => {
  const env = await guardEnv();
  const mark = (session: string, command: string) =>
    runHook('post-bash-mark', { session_id: session, cwd: '/x/git/other', tool_name: 'Bash', tool_input: { command } }, env);
  const viaOf = async (session: string) => JSON.parse(await readFile(join(env.TALLY_HOME, 'marks', session), 'utf8')).via;

  // the 2026-08-30 hub-session shapes: the snippet used to be `cat /tmp/x.md; echo ---` / `cd ~/git; echo "=== …`
  mark('p1', 'cat /tmp/x.md; echo ---; brief feedback 2>&1 | head -80');
  assert.equal((await viaOf('p1')).brief, 'brief feedback 2>&1 | head -80');
  mark('p2', "cd ~/git; echo \"=== peep dirty\"; git -C peep status --short; printf 'a\\nb\\nc\\n' | squirt --level warn 2>&1 | tail -3");
  assert.equal((await viaOf('p2')).squirt, "printf 'a\\nb\\nc\\n' | squirt --level warn 2>&1 | tail -3");
  // newline-separated statements
  mark('p3', 'echo one\nsnuff --json\necho two');
  assert.equal((await viaOf('p3')).snuff, 'snuff --json');
  // a single-statement command is unchanged, and the 60-char cap still applies
  mark('p4', 'cd /tmp && snuff --gate');
  assert.equal((await viaOf('p4')).snuff, 'cd /tmp && snuff --gate');
  mark('p5', `echo start; brief ${'--flag '.repeat(20)}| head -1`);
  const long = (await viaOf('p5')).brief as string;
  assert.equal(long.length, 60);
  assert.ok(long.startsWith('brief --flag'));

  // stop-feedback repeats the statement
  const blocked = runHook('stop-feedback', { session_id: 'p1' }, env);
  assert.equal(blocked.exit, 2);
  assert.match(blocked.message ?? '', /marked from: `brief feedback 2>&1 \| head -80`/);

  // the parse.ts export behind it
  const { usedToolStatementsCertain } = (await import('../src/parse.js')) as unknown as {
    usedToolStatementsCertain: (cmd: string, tools: readonly string[]) => { tool: string; statement: string }[];
  };
  assert.deepEqual(usedToolStatementsCertain('cat a; brief x | head -2', ['brief']), [{ tool: 'brief', statement: 'brief x | head -2' }]);
  assert.deepEqual(usedToolStatementsCertain('false && snuff; echo done', ['snuff']), [], 'certainty rule unchanged');
  assert.deepEqual(usedToolStatementsCertain('echo $(snuff --json) > out', ['snuff']), [{ tool: 'snuff', statement: 'echo $(snuff --json) > out' }], 'substitution stays inside its statement');
});
