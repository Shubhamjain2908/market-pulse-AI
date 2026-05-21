/**
 * Backfill `regime_daily` by running `runRegimeClassifier` oldest → newest.
 *
 * Usage:
 *   pnpm exec tsx scripts/backfill-regime.mts
 *     → last 90 NSE sessions ending today (IST).
 *   pnpm exec tsx scripts/backfill-regime.mts 2026-05-21
 *     → last 90 sessions ending at that ISO date (last open on/before).
 *   pnpm exec tsx scripts/backfill-regime.mts 2026-05-21 120
 *     → last 120 sessions ending at that date.
 *   pnpm exec tsx scripts/backfill-regime.mts --from 2023-01-01 --to 2026-05-21
 *     → every open NSE session in [from, to] (inclusive, snapped to open days).
 */

import { parseArgs } from 'node:util';

import { runRegimeClassifier } from '../src/analysers/regime-classifier.js';
import { closeDb, getDb, getTodayRegime, migrate } from '../src/db/index.js';
import { isIsoDate, isoDateIst } from '../src/ingestors/base/dates.js';
import {
  lastOpenOnOrBefore,
  listTradingDaysBackward,
  previousOpenTradingDay,
} from '../src/market/trading-days.js';
import { argvForCliParseArgs } from './argv-for-cli.js';

function listOpenSessionsAscending(fromIso: string, toIso: string): string[] {
  const start = lastOpenOnOrBefore(fromIso);
  const end = lastOpenOnOrBefore(toIso);
  if (!start || !end || start > end) return [];

  const newestFirst: string[] = [];
  let cur: string | null = end;
  while (cur) {
    newestFirst.push(cur);
    if (cur <= start) break;
    cur = previousOpenTradingDay(cur);
  }
  return newestFirst.slice().reverse();
}

const { values, positionals } = parseArgs({
  args: argvForCliParseArgs(),
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
  },
  allowPositionals: true,
});

let chronological: string[];
let rangeLabel: string;

if (values.from != null || values.to != null) {
  const from = values.from;
  const to = values.to;
  if (typeof from !== 'string' || typeof to !== 'string' || !isIsoDate(from) || !isIsoDate(to)) {
    console.error(
      'With --from/--to, both must be YYYY-MM-DD, e.g. --from 2023-01-01 --to 2026-05-21',
    );
    process.exitCode = 1;
    process.exit();
  }
  chronological = listOpenSessionsAscending(from, to);
  rangeLabel = `${from}..${to}`;
} else {
  const endDate =
    typeof positionals[0] === 'string' && isIsoDate(positionals[0]) ? positionals[0] : isoDateIst();
  const countRaw = positionals[1];
  const count =
    typeof countRaw === 'string' && Number.isFinite(Number(countRaw)) && Number(countRaw) > 0
      ? Math.floor(Number(countRaw))
      : 90;
  const window = listTradingDaysBackward(endDate, count);
  chronological = [...window].reverse();
  rangeLabel = endDate;
}

if (chronological.length === 0) {
  console.error('No trading sessions in range (check NSE calendar / from–to order).');
  process.exitCode = 1;
  process.exit();
}

migrate();
const db = getDb();

const histogram: Record<string, number> = {};
for (const d of chronological) {
  runRegimeClassifier({ date: d }, db);
  const row = getTodayRegime(d, db);
  const label = row?.regime ?? 'MISSING';
  histogram[label] = (histogram[label] ?? 0) + 1;
}

console.log(
  JSON.stringify({ range: rangeLabel, sessions: chronological.length, histogram }, null, 2),
);
closeDb();
