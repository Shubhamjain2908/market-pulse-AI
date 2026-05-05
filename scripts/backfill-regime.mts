/**
 * Backfill `regime_daily` for the last 90 NSE sessions ending at END_DATE (default: today IST).
 * Processes oldest → newest so persistence sees prior rows.
 */

import { runRegimeClassifier } from '../src/analysers/regime-classifier.js';
import { closeDb, getDb, getTodayRegime, migrate } from '../src/db/index.js';
import { isoDateIst } from '../src/ingestors/base/dates.js';
import { listTradingDaysBackward } from '../src/market/trading-days.js';

migrate();
const db = getDb();
const endDate = process.argv[2] ?? isoDateIst();
const window = listTradingDaysBackward(endDate, 90);
const chronological = [...window].reverse();

const histogram: Record<string, number> = {};
for (const d of chronological) {
  runRegimeClassifier({ date: d }, db);
  const row = getTodayRegime(d, db);
  const label = row?.regime ?? 'MISSING';
  histogram[label] = (histogram[label] ?? 0) + 1;
}

console.log(JSON.stringify({ endDate, sessions: chronological.length, histogram }, null, 2));
closeDb();
