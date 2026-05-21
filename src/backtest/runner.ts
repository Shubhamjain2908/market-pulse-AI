#!/usr/bin/env node
/**
 * Option A walk-forward backtest CLI.
 *
 * Usage:
 *   pnpm exec tsx src/backtest/runner.ts --strategy momentum-mf --from 2023-01-01 --to 2026-03-31
 *   pnpm exec tsx src/backtest/runner.ts --strategy all --regime-source proxy
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
import {
  type OptionARegimeSource,
  REGIME_PROXY_MIN_PRIOR_BARS,
  countBenchQuotesStrictlyBefore,
} from './regime-proxy.js';
import { buildOptionARunRow, tradesToDbRows } from './results.js';
import {
  PHASE1_INITIAL_MULTIPLIERS,
  computePhase1SweepRow,
  formatPhase1SweepTable,
} from './sweep-metrics.js';

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
  /** `proxy` (default): quotes-only coarse regime. `daily`: require regime_daily coverage gate. */
  regimeSource?: OptionARegimeSource;
  /** Single-run initial ATR multiplier override (momentum-mf). */
  initialMultiplier?: number;
  /** Phase 1 cross-sectional sweep over [1.5, 2.0, 2.5, 3.0] (momentum-mf only). */
  sweepInitialStop?: boolean;
}

function usage(): void {
  console.log(`Usage:
  pnpm exec tsx src/backtest/runner.ts \\
    --strategy momentum-mf|ai-pick|all \\
    [--from YYYY-MM-DD] [--to YYYY-MM-DD] \\
    [--min-history-days 504] [--cost-bps 20] [--regime-source proxy|daily] \\
    [--initial-multiplier 2.0] [--sweep-initial-stop] [--dry-run] [--verbose]

  Phase 1 trailing-stop sweep (momentum-mf):
    pnpm exec tsx src/backtest/runner.ts --strategy momentum-mf --sweep-initial-stop --dry-run
`);
}

function parseStrategy(s: string): OptionAStrategy | null {
  const u = s.trim().toLowerCase();
  if (u === 'momentum-mf' || u === 'momentum_mf') return 'momentum-mf';
  if (u === 'ai-pick' || u === 'ai_pick') return 'ai-pick';
  if (u === 'all') return 'all';
  return null;
}

function parseRegimeSource(s: string | undefined): OptionARegimeSource | null {
  if (s == null || s === '') return 'proxy';
  const u = s.trim().toLowerCase();
  if (u === 'proxy' || u === 'daily') return u;
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
  const regimeSource: OptionARegimeSource = input.regimeSource ?? 'proxy';

  let cov: ReturnType<typeof regimeCoverageForWindow> | null = null;
  let niftyPriorBars: number | null = null;

  if (regimeSource === 'daily') {
    if (tradingDays.length > 0) {
      cov = regimeCoverageForWindow(tradingDays, db);
      if (cov.ratio < REGIME_COVERAGE_MIN) {
        console.error(
          [
            'FATAL: regime_daily coverage for the backtest window is below 80%.',
            `  Window trading days: ${cov.totalDays}; days with regime row: ${cov.withRegime} (${(cov.ratio * 100).toFixed(1)}%).`,
            `  regime_daily MIN(date)=${cov.regimeMin} MAX(date)=${cov.regimeMax} COUNT=${cov.regimeCount}`,
            '  Run scripts/backfill-regime.mts (or the regime pipeline) until coverage is sufficient.',
            '  Or use --regime-source proxy for a quotes-only coarse regime (see src/backtest/regime-proxy.ts).',
            '  SQL: SELECT MIN(date), MAX(date), COUNT(*) FROM regime_daily;',
          ].join('\n'),
        );
        closeDb();
        process.exitCode = 1;
        return;
      }
    }
  } else {
    niftyPriorBars = countBenchQuotesStrictlyBefore(bench, input.from, db);
    if (niftyPriorBars < REGIME_PROXY_MIN_PRIOR_BARS) {
      console.error(
        [
          `FATAL: regime proxy requires at least ${REGIME_PROXY_MIN_PRIOR_BARS} NSE EOD rows for ${bench} strictly before --from (${input.from}).`,
          `  Found ${niftyPriorBars}. SMA200/slope need sufficient history.`,
          '  Ingest a longer NIFTY benchmark series (e.g. Yahoo ^NSEI mapped to NIFTY_50), then retry.',
          '  Or use --regime-source daily if regime_daily is backfilled for this window.',
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

  const regimeHist =
    regimeSource === 'daily' && tradingDays.length > 0
      ? regimeHistogramForTradingDates(tradingDays, db)
      : null;

  const regimeDebugHint =
    regimeSource === 'daily'
      ? 'regime_source=daily uses regime_daily (needs backfill + enrich/FII for realistic labels). Audit: pnpm exec tsx scripts/audit-regime-history.mts --from <from> --to <to>'
      : 'regime_source=proxy uses quotes-only 3-signal coarse labels (no regime_daily, no 3-day persistence); see src/backtest/regime-proxy.ts';

  console.log(
    JSON.stringify(
      {
        phase: 'option-a:start',
        from: input.from,
        to: input.to,
        strategy: input.strategy,
        regimeSource,
        benchmark: bench,
        benchmarkTradingDays: tradingDays.length,
        regimeCoverage:
          regimeSource === 'daily' && cov != null
            ? {
                withRegime: cov.withRegime,
                totalDays: cov.totalDays,
                ratio: Number(cov.ratio.toFixed(4)),
                regimeTableMin: cov.regimeMin,
                regimeTableMax: cov.regimeMax,
                regimeTableRowCount: cov.regimeCount,
              }
            : null,
        niftyPriorBarsStrictlyBeforeFrom:
          regimeSource === 'proxy'
            ? { required: REGIME_PROXY_MIN_PRIOR_BARS, actual: niftyPriorBars }
            : null,
        regimeLabelsInBacktestWindow: regimeSource === 'daily' ? regimeHist : null,
        regimeProxyNote:
          regimeSource === 'proxy'
            ? 'Proxy labels built once in engine (BULL=all3, BEAR=all3, else CHOPPY). See src/backtest/regime-proxy.ts'
            : null,
        universeSymbolCount: universe.length,
        minHistoryDays: input.minHistoryDays,
        costBpsRoundTrip: input.costBpsRoundTrip,
        dryRun: input.dryRun,
        survivorshipNote,
        regimeDebugHint,
      },
      null,
      2,
    ),
  );

  const verbose = input.verbose === true;

  if (input.sweepInitialStop === true) {
    if (input.strategy !== 'momentum-mf') {
      console.error('--sweep-initial-stop requires --strategy momentum-mf');
      closeDb();
      process.exitCode = 1;
      return;
    }
    const sweepRows = [];
    for (const mult of PHASE1_INITIAL_MULTIPLIERS) {
      const t0 = performance.now();
      const { byStrategy } = runOptionAEngine({
        strategy: 'momentum-mf',
        from: input.from,
        to: input.to,
        costBpsRoundTrip: input.costBpsRoundTrip,
        minHistoryDays: input.minHistoryDays,
        initialMultiplier: mult,
        universe,
        db,
        regimeSource,
      });
      if (verbose) {
        console.log(
          `[option-a] sweep mult=${mult} finished in ${Math.round(performance.now() - t0)}ms`,
        );
      }
      const trades = byStrategy.momentum_mf ?? [];
      sweepRows.push(computePhase1SweepRow(mult, trades));
    }
    console.log('\nPhase 1 initial-ATR multiplier sweep (momentum-mf, net metrics):');
    console.table(formatPhase1SweepTable(sweepRows));
    console.log(JSON.stringify({ phase: 'option-a:phase1-sweep-done', dryRun: true }, null, 2));
    closeDb();
    return;
  }

  const t0 = performance.now();
  const { byStrategy, universeUsed } = runOptionAEngine({
    strategy: input.strategy,
    from: input.from,
    to: input.to,
    costBpsRoundTrip: input.costBpsRoundTrip,
    minHistoryDays: input.minHistoryDays,
    initialMultiplier: input.initialMultiplier,
    universe,
    db,
    regimeSource,
  });
  if (verbose) {
    console.log(`[option-a] engine finished in ${Math.round(performance.now() - t0)}ms`);
  }

  const regimePersistNote =
    regimeSource === 'proxy'
      ? ' regime_source=proxy (quotes-only 3-signal regime; not regime_daily; no persistence).'
      : ' regime_source=daily (regime_daily table).';
  const notesCombined = `${survivorshipNote}${regimePersistNote}`;

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
      universe: universeUsed,
      trades,
      costBpsRoundTrip: input.costBpsRoundTrip,
      notes: notesCombined,
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
      'regime-source': { type: 'string', default: 'proxy' },
      'initial-multiplier': { type: 'string' },
      'sweep-initial-stop': { type: 'boolean', default: false },
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
  const regimeSourceRaw = values['regime-source'];
  const regimeSource = parseRegimeSource(
    typeof regimeSourceRaw === 'string' ? regimeSourceRaw : undefined,
  );
  const sweepInitialStop = values['sweep-initial-stop'] === true;
  const initialMultRaw = values['initial-multiplier'];
  let initialMultiplier: number | undefined;
  if (typeof initialMultRaw === 'string' && initialMultRaw.length > 0) {
    initialMultiplier = Number(initialMultRaw);
    if (!Number.isFinite(initialMultiplier) || initialMultiplier <= 0) {
      console.error('invalid --initial-multiplier');
      process.exitCode = 1;
      return;
    }
  }

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
  if (!regimeSource) {
    console.error('--regime-source must be proxy or daily');
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
    regimeSource,
    initialMultiplier,
    sweepInitialStop,
  });
}

void main().catch((err) => {
  console.error(err);
  closeDb();
  process.exitCode = 1;
});
