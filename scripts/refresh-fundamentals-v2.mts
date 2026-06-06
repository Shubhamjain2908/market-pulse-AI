/**
 * Refresh fundamentals for quality_garp v2 prep:
 * 1. Python yahoo_annual + promoter backfill (ROE/ROCE/debt history)
 * 2. Yahoo snapshot ingest for all active symbols (PE/PB/PEG/D/E)
 * 3. Screener.in scrape for ingest-all equity union (ROCE/PEG/D/E fallback)
 *
 * Usage: pnpm fundamentals:refresh
 *        pnpm fundamentals:refresh -- --skip-screener
 *        pnpm fundamentals:refresh -- --skip-annual
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { bootstrapIngestors } from '../src/ingestors/index.js';
import { ScreenerIngestor } from '../src/ingestors/screener/ingestor.js';
import { ingestYahooSnapshots } from '../src/ingestors/yahoo-snapshot-ingestor.js';
import { closeDb, getDb, upsertFundamentals } from '../src/db/index.js';
import { isoDateIst } from '../src/ingestors/base/dates.js';
import { child } from '../src/logger.js';
import { getIngestAllEquitySymbolsUnion } from '../src/market/ingest-symbols.js';
import { PROJECT_ROOT } from '../src/config/project-paths.js';

const log = child({ component: 'refresh-fundamentals-v2' });

function resolvePythonBin(): string {
  const venvPython = resolve(PROJECT_ROOT, '.venv-fundamentals/bin/python3');
  if (existsSync(venvPython)) return venvPython;
  return 'python3';
}

function runPythonBackfill(dbPath: string, pythonBin: string): Promise<number> {
  const script = resolve(PROJECT_ROOT, 'scripts/backfill_fundamentals.py');
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(pythonBin, [script, '--db', dbPath], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolvePromise(0);
      else reject(new Error(`backfill_fundamentals.py exited with code ${code}`));
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const skipAnnual = args.includes('--skip-annual');
  const skipScreener = args.includes('--skip-screener');
  const date = isoDateIst();
  const dbPath = resolve(PROJECT_ROOT, process.env.DATABASE_PATH ?? 'data/market-pulse.db');

  bootstrapIngestors();

  if (!skipAnnual) {
    log.info({ dbPath }, 'running yahoo_annual + promoter backfill');
    await runPythonBackfill(dbPath, resolvePythonBin());
  }

  // Screener first — Yahoo snapshot runs last so it wins on (symbol, as_of) conflicts
  // and preserves derived PEG / D/E for quality_garp.
  if (!skipScreener) {
    const symbols = getIngestAllEquitySymbolsUnion(getDb());
    log.info({ date, symbols: symbols.length }, 'running screener fundamentals ingest');
    const screener = new ScreenerIngestor();
    const result = await screener.fetchFundamentals({ date, symbols });
    const written = upsertFundamentals(result.data, getDb());
    log.info(
      { written, failed: result.failed.length, failedSample: result.failed.slice(0, 5) },
      'screener fundamentals ingest finished',
    );
  }

  log.info({ date }, 'running yahoo snapshot ingest (all active symbols)');
  const snap = await ingestYahooSnapshots(getDb(), { date });
  log.info(snap, 'yahoo snapshot ingest finished');

  closeDb();
  log.info('fundamentals refresh complete');
}

main().catch((err) => {
  log.error({ err: (err as Error).message }, 'fundamentals refresh failed');
  closeDb();
  process.exitCode = 1;
});
