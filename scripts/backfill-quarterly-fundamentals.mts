/**
 * One-shot backfill for `quarterly_fundamentals` from Screener.in.
 * Idempotent via upsertQuarterlyFundamentals. Uses the ScreenerIngestor
 * which rate-limits at 1 req/s (~3.5 min for 188 symbols).
 *
 * Usage: pnpm backfill:quarterly
 *        SYMBOLS=RELIANCE,INFY pnpm backfill:quarterly
 *        DATE=2026-06-29 pnpm backfill:quarterly
 */

import {
  closeDb,
  getDb,
  migrate,
  upsertFundamentals,
  upsertQuarterlyFundamentals,
} from '../src/db/index.js';
import { isoDateIst } from '../src/ingestors/base/dates.js';
import { ScreenerIngestor } from '../src/ingestors/screener/ingestor.js';
import { getIngestAllEquitySymbolsUnion } from '../src/market/ingest-symbols.js';

const BATCH_SIZE = 20;

async function main(): Promise<void> {
  migrate();
  const db = getDb();
  const asOf = process.env.DATE?.trim() || isoDateIst();
  const explicitEnv = process.env.SYMBOLS?.trim();
  const symbols = explicitEnv
    ? explicitEnv
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
    : getIngestAllEquitySymbolsUnion(db);

  console.log(`Backfilling ${symbols.length} symbols from Screener.in (asOf=${asOf})`);

  const ingestor = new ScreenerIngestor();
  let totalQuarterly = 0;
  let totalFailed = 0;

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const chunk = symbols.slice(i, i + BATCH_SIZE);
    const r = await ingestor.fetchFundamentals({ date: asOf, symbols: chunk });
    totalFailed += r.failed.length;
    const quarterlyWritten = r.quarterlyData ? upsertQuarterlyFundamentals(r.quarterlyData, db) : 0;
    totalQuarterly += quarterlyWritten;
    // Also upsert fundamentals so subsequent runs skip (no-op on conflict)
    upsertFundamentals(r.data, db);
    console.log(
      `  batch ${Math.floor(i / BATCH_SIZE) + 1}: wrote ${quarterlyWritten} quarterly rows; cumulative failures ${totalFailed}`,
    );
  }

  console.log(
    `Done. ${totalQuarterly} quarterly rows upserted across ${symbols.length} symbols (${totalFailed} failed).`,
  );
  closeDb();
}

void main().catch((err) => {
  console.error('backfill failed:', (err as Error).message);
  closeDb();
  process.exitCode = 1;
});
