#!/usr/bin/env node
/**
 * Option A walk-forward backtest CLI.
 *
 * Usage:
 *   pnpm exec tsx src/backtest/runner.ts --strategy momentum-mf --from 2023-01-01 --to 2026-03-31
 *   pnpm exec tsx src/backtest/runner.ts --strategy all --min-history-days 504 --cost-bps 20
 */

import { parseArgs } from 'node:util';

import { getMomentumUniverseSymbols } from '../config/loaders.js';
import {
  insertOptionABacktestRun,
  insertOptionABacktestTrades,
  listBenchmarkTradingDates,
  regimeCoverageForWindow,
  regimeHistogramForTradingDates,
} from '../db/backtest-queries.js';
import { closeDb, getDb, migrate } from '../db/index.js';
import { isIsoDate } from '../ingestors/base/dates.js';
import { NIFTY_BENCHMARK_SYMBOL } from '../market/benchmarks.js';
import { type OptionAStrategy, type RunOptionAEngineResult, runOptionAEngine } from './engine.js';
import { buildOptionARunRow, tradesToDbRows } from './results.js';

const DEFAULT_FROM = '2023-01-01';
const DEFAULT_TO = '2026-03-31';
const REGIME_COVERAGE_MIN = 0.8;

export interface OptionARunnerInput {
  strategy: OptionAStrategy;
  from: string;
  to: string;
  minHistoryDays: number;
  costBpsRoundTrip: number;
  dryRun: boolean;
  /** Extra timing / engine breadcrumbs (default false). */
  verbose?: boolean;
}

function usage(): void {
  console.log(`Usage:
  pnpm exec tsx src/backtest/runner.ts \\
    --strategy momentum-mf|ai-pick|all \\
    [--from YYYY-MM-DD] [--to YYYY-MM-DD] \\
    [--min-history-days 504] [--cost-bps 20] [--dry-run] [--verbose]
`);
}

function parseStrategy(s: string): OptionAStrategy | null {
  const u = s.trim().toLowerCase();
  if (u === 'momentum-mf' || u === 'momentum_mf') return 'momentum-mf';
  if (u === 'ai-pick' || u === 'ai_pick') return 'ai-pick';
  if (u === 'all') return 'all';
  return null;
}

function keysForStrategy(
  strategy: OptionAStrategy,
): Array<keyof RunOptionAEngineResult['byStrategy']> {
  const out: Array<keyof RunOptionAEngineResult['byStrategy']> = [];
  if (strategy === 'momentum-mf' || strategy === 'all') out.push('momentum_mf');
  if (strategy === 'ai-pick' || strategy === 'all') out.push('ai_pick');
  return out;
}

/** Programmatic entry (e.g. `mp backtest-option-a`) — same behaviour as CLI `main`. */
export async function runOptionABacktestJob(input: OptionARunnerInput): Promise<void> {
  migrate();
  const db = getDb();

  const bench = NIFTY_BENCHMARK_SYMBOL.toUpperCase();
  const tradingDays = listBenchmarkTradingDates(bench, input.from, input.to, db);

  let cov: ReturnType<typeof regimeCoverageForWindow> | null = null;
  if (tradingDays.length > 0) {
    cov = regimeCoverageForWindow(tradingDays, db);
    if (cov.ratio < REGIME_COVERAGE_MIN) {
      console.error(
        [
          'FATAL: regime_daily coverage for the backtest window is below 80%.',
          `  Window trading days: ${cov.totalDays}; days with regime row: ${cov.withRegime} (${(cov.ratio * 100).toFixed(1)}%).`,
          `  regime_daily MIN(date)=${cov.regimeMin} MAX(date)=${cov.regimeMax} COUNT=${cov.regimeCount}`,
          '  Run scripts/backfill-regime.mts (or the regime pipeline) until coverage is sufficient.',
          '  SQL: SELECT MIN(date), MAX(date), COUNT(*) FROM regime_daily;',
        ].join('\n'),
      );
      closeDb();
      process.exitCode = 1;
      return;
    }
  }

  const universe = getMomentumUniverseSymbols({ fresh: true });
  const survivorshipNote =
    'Survivorship bias: symbols absent from quotes are excluded; delisted names may inflate results.';

  const regimeHist = tradingDays.length > 0 ? regimeHistogramForTradingDates(tradingDays, db) : {};

  console.log(
    JSON.stringify(
      {
        phase: 'option-a:start',
        from: input.from,
        to: input.to,
        strategy: input.strategy,
        benchmark: bench,
        benchmarkTradingDays: tradingDays.length,
        regimeCoverage:
          cov != null
            ? {
                withRegime: cov.withRegime,
                totalDays: cov.totalDays,
                ratio: Number(cov.ratio.toFixed(4)),
                regimeTableMin: cov.regimeMin,
                regimeTableMax: cov.regimeMax,
                regimeTableRowCount: cov.regimeCount,
              }
            : null,
        regimeLabelsInBacktestWindow: regimeHist,
        universeSymbolCount: universe.length,
        minHistoryDays: input.minHistoryDays,
        costBpsRoundTrip: input.costBpsRoundTrip,
        dryRun: input.dryRun,
        survivorshipNote,
        regimeDebugHint:
          'Persisted labels need score inputs (NIFTY/VIX quotes, fii_dii, signals close+sma_200 for breadth) plus 3-session persistence. If you never see BULL_TRENDING, run: pnpm exec tsx scripts/audit-regime-history.mts --from <from> --to <to>',
      },
      null,
      2,
    ),
  );

  const verbose = input.verbose === true;
  const t0 = performance.now();
  const { byStrategy } = runOptionAEngine({
    strategy: input.strategy,
    from: input.from,
    to: input.to,
    costBpsRoundTrip: input.costBpsRoundTrip,
    minHistoryDays: input.minHistoryDays,
    universe,
    db,
  });
  if (verbose) {
    console.log(`[option-a] engine finished in ${Math.round(performance.now() - t0)}ms`);
  }

  if (input.dryRun) {
    const keysToReport = keysForStrategy(input.strategy);
    for (const sid of keysToReport) {
      const trades = byStrategy[sid] ?? [];
      console.log(`[option-a] dry-run ${sid}: ${trades.length} simulated trade(s)`);
    }
    console.log(JSON.stringify({ phase: 'option-a:done', dryRun: true }, null, 2));
    closeDb();
    return;
  }

  const keysToPersist = keysForStrategy(input.strategy);
  for (const sid of keysToPersist) {
    const trades = byStrategy[sid] ?? [];
    const holdDays = sid === 'ai_pick' ? 20 : 90;
    const row = buildOptionARunRow({
      strategyId: sid,
      from: input.from,
      to: input.to,
      holdDays,
      universe,
      trades,
      costBpsRoundTrip: input.costBpsRoundTrip,
      notes: survivorshipNote,
    });
    const runId = insertOptionABacktestRun(row, db);
    insertOptionABacktestTrades(runId, tradesToDbRows(trades), db);
    console.log(
      JSON.stringify(
        {
          strategyId: sid,
          runId,
          totalTrades: row.totalTrades,
          hitRate: row.hitRate,
          avgReturnPct: row.avgReturnPct,
          expectancy: row.expectancy,
          profitFactor: row.profitFactor,
        },
        null,
        2,
      ),
    );
  }

  console.log(JSON.stringify({ phase: 'option-a:done', dryRun: false }, null, 2));
  closeDb();
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      strategy: { type: 'string' },
      from: { type: 'string', default: DEFAULT_FROM },
      to: { type: 'string', default: DEFAULT_TO },
      'min-history-days': { type: 'string', default: '504' },
      'cost-bps': { type: 'string', default: '20' },
      'dry-run': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const stratRaw = values.strategy;
  const from = values.from;
  const to = values.to;
  const dryRun = values['dry-run'] === true;
  const verbose = values.verbose === true;
  const minHistoryDays = Number(values['min-history-days']);
  const costBps = Number(values['cost-bps']);

  if (typeof stratRaw !== 'string') {
    usage();
    process.exitCode = 1;
    return;
  }
  const strategy = parseStrategy(stratRaw);
  if (!strategy) {
    console.error(`Unknown --strategy ${stratRaw}`);
    process.exitCode = 1;
    return;
  }
  if (typeof from !== 'string' || typeof to !== 'string' || !isIsoDate(from) || !isIsoDate(to)) {
    console.error('--from and --to must be YYYY-MM-DD');
    process.exitCode = 1;
    return;
  }
  if (!Number.isFinite(minHistoryDays) || minHistoryDays < 1) {
    console.error('invalid --min-history-days');
    process.exitCode = 1;
    return;
  }
  if (!Number.isFinite(costBps) || costBps < 0) {
    console.error('invalid --cost-bps');
    process.exitCode = 1;
    return;
  }

  await runOptionABacktestJob({
    strategy,
    from,
    to,
    minHistoryDays,
    costBpsRoundTrip: costBps,
    dryRun,
    verbose,
  });
}

void main().catch((err) => {
  console.error(err);
  closeDb();
  process.exitCode = 1;
});
