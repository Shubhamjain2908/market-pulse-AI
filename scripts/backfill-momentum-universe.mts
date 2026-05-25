/**
 * One-shot Yahoo backfill for `config/momentum-universe.json` (~150 symbols × ~260 trading days).
 * Writes **quotes only** — not `mom_12_1_return` or other `mom_*` factor signals (those come from `pnpm cli enrich`).
 * Requires network. Idempotent via `upsertQuotes`.
 *
 * Usage: `pnpm momentum:backfill-universe` or `AS_OF=2026-05-07 pnpm momentum:backfill-universe`
 */

import { getMomentumUniverseSymbols } from '../src/config/loaders.js';
import { closeDb, getDb, migrate, upsertQuotes } from '../src/db/index.js';
import { isoDateIst } from '../src/ingestors/base/dates.js';
import { YahooIngestor } from '../src/ingestors/yahoo/ingestor.js';

const BATCH = 12;
/** Calendar days — covers ~260 NSE sessions with buffer. */
const LOOKBACK_DAYS = 400;

async function main(): Promise<void> {
  migrate();
  const db = getDb();
  const asOf = process.env.AS_OF?.trim() || isoDateIst();
  const symbols = getMomentumUniverseSymbols({ fresh: true });
  const ingestor = new YahooIngestor({ lookbackDays: LOOKBACK_DAYS });

  let rowsUpserted = 0;
  let failedTotal = 0;

  for (let i = 0; i < symbols.length; i += BATCH) {
    const chunk = symbols.slice(i, i + BATCH);
    const r = await ingestor.fetchQuotes({ date: asOf, symbols: chunk });
    rowsUpserted += upsertQuotes(r.data, db);
    failedTotal += r.failed.length;
    if (r.failed.length > 0) {
      console.warn(`batch ${i / BATCH + 1}: failed symbols`, r.failed);
    }
    console.log(
      `batch ${Math.floor(i / BATCH) + 1}: wrote ${r.data.length} quote rows; cumulative failures ${failedTotal}`,
    );
  }

  console.log(
    `Done. upsertCalls=${rowsUpserted} quote rows (may count statement batches); symbols=${symbols.length}; asOf=${asOf}`,
  );
  console.log(
    `Next: factor signals (e.g. mom_12_1_return) require enrich — pnpm cli enrich -d ${asOf}`,
  );
  closeDb();
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
