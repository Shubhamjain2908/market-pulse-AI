/**
 * Yahoo earnings calendar refresh for `config/momentum-universe.json`.
 * Idempotent; clears per-symbol rows on Yahoo miss (fail-open).
 *
 * Usage: `pnpm momentum:refresh-earnings` or `AS_OF=2026-05-07 pnpm momentum:refresh-earnings`
 */

import { getMomentumUniverseSymbols } from '../src/config/loaders.js';
import { closeDb, getDb, migrate } from '../src/db/index.js';
import { isoDateIst } from '../src/ingestors/base/dates.js';
import { syncMomentumEarningsCalendarFromYahoo } from '../src/ingestors/yahoo/earnings-ingestor.js';

async function main(): Promise<void> {
  migrate();
  const db = getDb();
  const asOf = process.env.AS_OF?.trim() || isoDateIst();
  const symbols = getMomentumUniverseSymbols({ fresh: true });
  const result = await syncMomentumEarningsCalendarFromYahoo(symbols, db, { refDate: asOf });
  console.log(JSON.stringify({ asOf, ...result }, null, 2));
  closeDb();
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
