import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Report } from './types.js';

export function tallyHome(): string {
  return process.env.TALLY_HOME || join(homedir(), '.tally');
}

/** ISO 8601 week, e.g. "2026-33". */
export function isoWeek(d = new Date()): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7; // Mon=1..Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-${String(week).padStart(2, '0')}`;
}

const NAME_RE = /^[\w.-]{1,64}$/;

function snapPath(name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`snapshot name must match ${NAME_RE}, got ${JSON.stringify(name)}`);
  return join(tallyHome(), `${name}.json`);
}

export async function saveSnap(name: string, report: Report): Promise<string> {
  const path = snapPath(name);
  await mkdir(tallyHome(), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

export async function loadSnap(name: string): Promise<Report | undefined> {
  try {
    return JSON.parse(await readFile(snapPath(name), 'utf8')) as Report;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}
