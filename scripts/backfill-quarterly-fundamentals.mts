/**
 * One-shot backfill for `quarterly_fundamentals` from Screener.in's
 * `#quarters` and `#cash-flow` tables.
 *
 * Uses the existing ScreenerIngestor (rate-limited at 1 req/s). For ~241
 * symbols the run takes ≈4 minutes. Idempotent via `upsertQuarterlyFundamentals`.
 *
 * Usage:
 *   pnpm backfill:quarterly
 *   DATE=2026-06-29 pnpm backfill:quarterly          # custom asOf date
 *   SYMBOLS=RELIANCE,INFY,TCS pnpm backfill:quarterly # specific symbols only
 *   SKIP_SCREENER_CHECK=1 pnpm backfill:quarterly     # skip 'is this production?' prompt
 */

import { closeDb, getDb, migrate, upsertQuarterlyFundamentals } from '../src/db/index.js';
import { isoDateIst } from '../src/ingestors/base/dates.js';
import { ScreenerIngestor } from '../src/ingestors/screener/ingestor.js';
import { getIngestAllEquitySymbolsUnion } from '../src/market/ingest-symbols.js';

/** Symbols per batch for progress reporting (~20 seconds per batch at 1 req/s). */
const BATCH_SIZE = 20;

function elapsed(start: bigint): string {
  const secs = Number(process.hrtime.bigint() - start) / 1e9;
  if (secs < 60) return `${secs.toFixed(0)}s`;
  return `${Math.floor(secs / 60)}m ${(secs % 60).toFixed(0)}s`;
}

function formatSymbolList(symbols: string[], max = 5): string {
  const shown = symbols.slice(0, max);
  const rest = symbols.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} +${rest} more` : shown.join(', ');
}

async function main(): Promise<void> {
  // ── Safety prompt for production DB ────────────────────────────────────
  if (!process.env.SKIP_SCREENER_CHECK) {
    const dbPath = process.env.DATABASE_PATH ?? 'data/market-pulse.db';
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║  Screener.in Quarterly Fundamentals Backfill           ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  DB:    ${dbPath.padEnd(43)}║`);
    console.log('║  Rate:  1 request/s (approx. 4 minutes for full set)   ║');
    console.log('║  This will make ~241 HTTP requests to screener.in     ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('Press Ctrl+C within 5s to cancel, or wait to proceed…');
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  const start = process.hrtime.bigint();
  migrate();
  const db = getDb();

  const asOf = process.env.DATE?.trim() || isoDateIst();

  // ── Resolve symbol universe ────────────────────────────────────────────
  const explicitEnv = process.env.SYMBOLS?.trim();
  let symbols: string[];
  if (explicitEnv) {
    symbols = explicitEnv
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    console.log(`[info] using explicit SYMBOLS env: ${symbols.length} symbols`);
  } else {
    symbols = getIngestAllEquitySymbolsUnion(db);
    console.log(
      `[info] resolved backfill universe: ${symbols.length} symbols from getIngestAllEquitySymbolsUnion`,
    );
  }

  console.log(`\nBackfilling ${symbols.length} symbols from Screener.in (asOf=${asOf})…\n`);

  const ingestor = new ScreenerIngestor();
  let totalRows = 0;
  let totalFailed = 0;
  let processed = 0;

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const chunk = symbols.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(symbols.length / BATCH_SIZE);
    const pct = ((i / symbols.length) * 100).toFixed(1);

    const r = await ingestor.fetchQuarterlyFundamentals({
      date: asOf,
      symbols: chunk,
    });

    const written = upsertQuarterlyFundamentals(r.data, db);
    totalRows += written;
    totalFailed += r.failed.length;
    processed += chunk.length;

    const elapsedStr = elapsed(start);
    const rate = (processed / Math.max(1, Number(process.hrtime.bigint() - start) / 1e9)).toFixed(
      1,
    );
    const remaining = symbols.length - processed;

    const rowDetail =
      r.data.length > 0
        ? `rows=${written} (${(r.data.length / chunk.length).toFixed(1)}/sym avg)`
        : 'rows=0';

    const failDetail =
      r.failed.length > 0 ? ` failed=${r.failed.length} [${formatSymbolList(r.failed)}]` : '';

    console.log(
      `[${batchNum}/${totalBatches}] ${pct}% processed  ` +
        `elapsed=${elapsedStr}  rate=${rate}/s  ` +
        `remaining=${remaining} syms  ${rowDetail}${failDetail}`,
    );

    // Brief inter-batch pause as a safety buffer on top of the ingestor's
    // built-in 1 req/s token-bucket rate limiter.
    if (i + BATCH_SIZE < symbols.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────
  const totalElapsed = elapsed(start);
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Backfill complete.');
  console.log(`  Symbols processed:   ${processed}`);
  console.log(`  Rows upserted:       ${totalRows}`);
  console.log(`  Failed symbols:      ${totalFailed}`);
  console.log(
    `  Avg rows per symbol: ${processed > 0 ? (totalRows / processed).toFixed(1) : 'N/A'}`,
  );
  console.log(`  Elapsed:             ${totalElapsed}`);

  if (totalFailed > 0 && totalFailed < processed) {
    console.log(`\n  ⚠  ${totalFailed} symbol(s) had fetch or parse failures.`);
    console.log('     These can be retried individually:');
    console.log(`     SYMBOLS=<LIST> pnpm backfill:quarterly`);
  } else if (totalFailed === processed) {
    console.log('\n  ❌ All symbols failed. Check network / screener.in availability.');
  } else {
    console.log('\n  ✅ All symbols succeeded.');
  }
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('Next steps:');
  console.log('  - Verify coverage:');
  console.log(
    `      sqlite3 data/market-pulse.db "SELECT symbol, COUNT(*) AS q, ` +
      `MAX(quarter_end) AS latest FROM quarterly_fundamentals GROUP BY symbol ORDER BY symbol;"`,
  );
  console.log(
    '  - The daily pipeline already persists quarterly_fundamentals via runDailyIngestor().',
  );
  console.log('  - Existing data will be preserved/merged via COALESCE upsert semantics.\n');

  closeDb();
}

void main().catch((err) => {
  console.error('backfill failed:', (err as Error).message);
  closeDb();
  process.exitCode = 1;
});
