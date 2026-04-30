/**
 * Backtester agent. Thin wrapper around `runBacktest` so the CLI/cron
 * callers don't need to reach into the harness directly.
 */

import { type BacktestOptions, type BacktestSummary, runBacktest } from '../backtest/index.js';
import { child } from '../logger.js';

const log = child({ component: 'backtester' });

export async function runBacktester(opts: BacktestOptions): Promise<BacktestSummary> {
  const summary = runBacktest(opts);
  log.info(
    {
      runs: summary.totalRuns,
      window: `${opts.startDate} → ${opts.endDate}`,
      holdDays: opts.holdDays ?? 10,
      summary: summary.results.map((r) => ({
        screen: r.screenName,
        runId: r.runId,
        trades: r.metrics.totalTrades,
        hitRate: Number(r.metrics.hitRate.toFixed(3)),
        avgReturn: Number(r.metrics.avgReturnPct.toFixed(2)),
      })),
    },
    'backtester complete',
  );
  return summary;
}
