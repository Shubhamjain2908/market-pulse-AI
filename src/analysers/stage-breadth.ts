/**
 * Stage-4 breadth monitor — slow-bleed detection.
 *
 * Computes `pctStage4`: share of momentum-universe symbols where the latest
 * `weinstein_stage_code` signal equals 4 (Weinstein Stage 4 = distribution).
 * Written as a market-level signal on `NIFTY_50` for daily logging / drift tracking.
 *
 * Task D2 — observe-safe: no regime change, no gating.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { getMomentumUniverseSymbols } from '../config/loaders.js';
import { upsertSignals } from '../db/queries.js';
import { child } from '../logger.js';
import { NIFTY_BENCHMARK_SYMBOL } from '../market/benchmarks.js';

const log = child({ component: 'stage-breadth' });

export interface StageBreadthResult {
  /** Date the metric was computed for. */
  date: string;
  /** Total momentum-universe symbols queried. */
  totalSymbols: number;
  /** Symbols with a weinstein_stage_code signal on this date. */
  withStage: number;
  /** Symbols with weinstein_stage_code = 4. */
  stage4Count: number;
  /** Percentage of withStage symbols in Stage 4. */
  pctStage4: number;
}

/**
 * Compute `stage4_breadth_pct` for a given date and persist as a signal
 * on the `NIFTY_50` benchmark symbol.
 *
 * Gracefully handles missing data: if no symbols have stage signals, returns
 * `pctStage4: 0` and does not write a signal.
 */
export function computeStage4Breadth(date: string, db: DatabaseType): StageBreadthResult {
  const universe = getMomentumUniverseSymbols().map((s) => s.toUpperCase());
  if (universe.length === 0) {
    return { date, totalSymbols: 0, withStage: 0, stage4Count: 0, pctStage4: 0 };
  }

  const placeholders = universe.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT symbol, value FROM signals
       WHERE date = ? AND name = 'weinstein_stage_code'
         AND symbol IN (${placeholders})`,
    )
    .all(date, ...universe) as Array<{ symbol: string; value: number }>;

  const withStage = rows.length;
  const stage4Count = rows.filter((r) => r.value === 4).length;
  const pctStage4 = withStage > 0 ? (stage4Count / withStage) * 100 : 0;

  if (withStage > 0) {
    upsertSignals(
      [
        {
          symbol: NIFTY_BENCHMARK_SYMBOL,
          date,
          name: 'stage4_breadth_pct',
          value: pctStage4,
          source: 'stage-breadth',
        },
      ],
      db,
    );
    log.info(
      { date, totalSymbols: universe.length, withStage, stage4Count, pctStage4 },
      'stage4_breadth computed',
    );
  } else {
    log.warn(
      { date, totalSymbols: universe.length },
      'stage4_breadth: no weinstein_stage_code signals found',
    );
  }

  return { date, totalSymbols: universe.length, withStage, stage4Count, pctStage4 };
}
