import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import type { Usage } from './types.js';

export interface PricingRate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const DEFAULT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'pricing.json');

function isValidRate(v: unknown): v is PricingRate {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (['input', 'output', 'cacheRead', 'cacheWrite'] as const).every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]));
}

/** repo-root `pricing.json`: $/Mtok per model, `_note` and other `_`-prefixed keys ignored.
 *  A hand-edited entry missing a field is dropped (with a stderr warning) rather than
 *  silently producing a NaN `estCost` that would render as a literal "$NaN". */
export function loadPricing(path: string = DEFAULT_PATH): Record<string, PricingRate> {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const rates: Record<string, PricingRate> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    if (!isValidRate(v)) {
      console.error(`pricing.json: skipping "${k}" — needs numeric input/output/cacheRead/cacheWrite`);
      continue;
    }
    rates[k] = v;
  }
  return rates;
}

export function costOf(usage: Usage, rate: PricingRate): number {
  return (usage.input / 1_000_000) * rate.input
    + (usage.output / 1_000_000) * rate.output
    + (usage.cacheRead / 1_000_000) * rate.cacheRead
    + (usage.cacheCreate / 1_000_000) * rate.cacheWrite;
}
