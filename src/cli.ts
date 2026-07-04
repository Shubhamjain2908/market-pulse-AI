#!/usr/bin/env node
/**
 * Market Pulse AI - CLI entry point.
 *
 * Subcommands map 1:1 to pipeline stages so each can be run in isolation:
 *
 *   mp migrate           Apply DB migrations
 *   mp ingest            Stage 1 - pull data from configured sources (`-s all` = watchlist ∪ momentum ∪ portfolio)
 *   mp enrich            Stage 2 - compute signals from raw data
 *   mp momentum-rank      Phase 4.1 - momentum composite + ranks (signals)
 *   mp momentum-rebalance Phase 4.2 - regime gate, rank exits, entries (paper_trades)
 *   mp screen            Stage 3 - run screens + alert scan against today's signals
 *   mp backtest-option-a  Option A walk-forward (momentum_mf / ai_pick; regime coverage gate)
 *   mp backtest          Replay screens against historical EOD data
 *   mp sentiment         Score news headlines via LLM
 *   mp thesis            Generate AI theses for top-signal stocks
 *   mp evaluate           Mark outcomes for open paper trades vs EOD quotes
 *   mp run-all           Alias for full daily workflow (portfolio sync + all stages + brief)
 *   mp daily             One-shot: full pipeline + portfolio analysis (recommended)
 *   mp sync-sectors      Cache Yahoo sector/industry in `symbols` (for portfolio sector rollup)
 *   mp kite-login        Refresh Zerodha Kite Connect access_token (run daily)
 *   mp portfolio-sync    Pull holdings from Kite (or manual) into the DB
 *   mp portfolio-analyse Run LLM-driven HOLD/ADD/TRIM/EXIT analysis per holding
 *   mp scan              One-shot intraday LTP refresh via Kite (cron-able)
 *   mp schedule          Start croner jobs (08:45 / 16:30 weekdays, Sat 08:00, Sun 06:00 earnings)
 *   mp ext-signal-smoke  Live ext-signal ingest + portfolio overlap report
 *   mp fundamental-screen-audit  quality/dividend screen bottleneck audit
 *   mp ext-signal-cross-ref  ext signals vs watchlist/momentum/portfolio overlap
 *   mp stage-history     Query pipeline stage results for the trailing N days
 *   mp doctor            Print runtime/config diagnostics
 *   mp regime            Full regime agent (classify + LLM narrative → regime_daily)
 *   mp regime:gate-summary  Print allowed strategies for today's regime
 * Run `mp --help` or `mp <cmd> --help` for full options.
 */

import { Command } from 'commander';
import { runBriefingComposer } from './agents/briefing-composer.js';
import { analyseConcallTranscripts } from './agents/concall-analyser.js';
import { runDailyIngestor } from './agents/daily-ingestor.js';
import { runDailyWorkflow } from './agents/daily-workflow.js';
import { runLiveScan } from './agents/live-scanner.js';
import { analysePortfolio } from './agents/portfolio-analyser.js';
import { runPortfolioSync } from './agents/portfolio-sync.js';
import { runRegimeAgent } from './agents/regime-agent.js';
import { runSignalEnricher } from './agents/signal-enricher.js';
import { runStockScreener } from './agents/stock-screener.js';
import { generateTheses } from './agents/thesis-generator.js';
import { runBacktest } from './backtest/harness.js';
import { deliverBriefing } from './briefing/dispatch.js';
import { config } from './config/env.js';
import { APP_NAME, APP_VERSION } from './constants.js';
import {
  closeDb,
  countGatesForRegime,
  getDb,
  getRegimeForCalendarDate,
  listAllowedGatesForRegime,
  migrate,
} from './db/index.js';
import { getStageHistory } from './db/pipeline-queries.js';
import { queryGateAudit, getGateAuditSummary } from './db/index.js';
import { enrichSentiment } from './enrichers/sentiment/enricher.js';
import { isoDateIst, optionalCliIsoDate } from './ingestors/base/dates.js';
import { runKiteLogin } from './ingestors/kite/auth.js';
import { fetchConcallTranscripts } from './ingestors/nse/announcements-fetcher.js';
import { logger } from './logger.js';
import {
  defaultIngestSymbolUniverse,
  getIngestAllEquitySymbolsUnion,
} from './market/ingest-symbols.js';
import { getMarketClosure } from './market/nse-calendar.js';
import { syncSymbolSectorsFromYahoo } from './market/yahoo-sectors.js';
import { runMomentumRanker } from './rankers/momentum-ranker.js';
import { startScheduler } from './scheduler/market-scheduler.js';
import { runEvaluatePaperTrades } from './scripts/evaluate-trades.js';
import { runExtSignalCrossRef } from './scripts/ext-signal-cross-ref.js';
import { runExtSignalSmoke } from './scripts/ext-signal-smoke.js';
import { runFundamentalScreenAudit } from './scripts/fundamental-screen-audit.js';
import {
  runMomentumRebalance,
  toMomentumRebalanceBriefingSummary,
} from './strategies/momentum-rebalance.js';

const program = new Command();

program
  .name('mp')
  .description(`${APP_NAME} - personal Indian-markets briefing pipeline`)
  .version(APP_VERSION)
  .option('-d, --date <YYYY-MM-DD>', 'target trading date (defaults to today, IST)')
  .option('--no-color', 'disable coloured output');

program
  .command('migrate')
  .description('apply database migrations (idempotent)')
  .action(async () => {
    const result = migrate();
    logger.info({ ...result }, 'migrations done');
    closeDb();
  });

program
  .command('regime:gate-summary')
  .description(
    'print allowed strategies + size multipliers for the regime on the given date (default today)',
  )
  .action(async () => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date) ?? isoDateIst();
    const row = getRegimeForCalendarDate(date, getDb());
    if (!row) {
      console.log(JSON.stringify({ date, error: 'no_regime_daily_row' }, null, 2));
      closeDb();
      process.exitCode = 1;
      return;
    }
    const active = listAllowedGatesForRegime(row.regime, getDb());
    const total = countGatesForRegime(row.regime, getDb());
    console.log(
      JSON.stringify(
        {
          date: row.date,
          regime: row.regime,
          activeStrategies: active,
          totalGateRows: total,
        },
        null,
        2,
      ),
    );
    closeDb();
  });

program
  .command('regime')
  .description('full regime agent: classify + LLM narrative (or templated fallback) → regime_daily')
  .option('--no-narrative', 'skip LLM; persist templated fallback narrative only')
  .action(async () => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date);
    const skipLlm = process.argv.includes('--no-narrative');
    const result = await runRegimeAgent({ date, skipLlm });
    logger.info(
      {
        regime: result.regime,
        changed: result.changed,
        usedFallbackNarrative: result.usedFallbackNarrative,
      },
      'regime agent complete',
    );
    console.log(JSON.stringify(result, null, 2));
    closeDb();
  });

program
  .command('ingest')
  .description('stage 1: pull market data from configured sources')
  .option(
    '-s, --symbols <list>',
    'comma-separated symbols, or the keyword `all` for watchlist ∪ momentum-universe ∪ portfolio (config + latest DB holdings), deduped',
  )
  .action(async (opts: { symbols?: string }) => {
    ensureDb();
    const raw = opts.symbols
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    let symbols: string[] | undefined;
    const token = raw?.[0];
    if (raw?.length === 1 && token !== undefined && token.toLowerCase() === 'all') {
      symbols = getIngestAllEquitySymbolsUnion(getDb());
      logger.info({ count: symbols.length, mode: 'all' }, 'ingest symbol universe');
    } else if (raw?.length) {
      symbols = raw.map((s) => s.toUpperCase());
    }
    const date = optionalCliIsoDate(program.opts().date);
    const result = await runDailyIngestor({ date, symbols });
    logger.info(result, 'ingest complete');
    closeDb();
  });

program
  .command('sync-sectors')
  .description(
    'fetch Yahoo Finance sector/industry for symbols missing rows in `symbols` (watchlist + holdings + benchmarks skipped)',
  )
  .option('-s, --symbols <list>', 'comma-separated symbols (default: full ingest universe)')
  .option('--force', 'refresh sector even when already cached')
  .action(async (opts: { symbols?: string; force?: boolean }) => {
    ensureDb();
    const explicit = opts.symbols
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const universe = explicit?.length
      ? explicit.map((s) => s.toUpperCase())
      : defaultIngestSymbolUniverse(getDb());
    const result = await syncSymbolSectorsFromYahoo(universe, getDb(), {
      force: Boolean(opts.force),
    });
    logger.info(result, 'sync-sectors complete');
    closeDb();
  });

program
  .command('enrich')
  .description('stage 2: technical indicators + momentum factors (universe) + blackout')
  .option('-s, --symbols <list>', 'comma-separated list of symbols')
  .action(async (opts: { symbols?: string }) => {
    ensureDb();
    const symbols = opts.symbols
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const date = optionalCliIsoDate(program.opts().date);
    const result = await runSignalEnricher({ date, symbols });
    logger.info(result, 'enrich complete');
    closeDb();
  });

program
  .command('momentum-rank')
  .description('phase 4.1: momentum composite z-score rank + false-flag (writes signals)')
  .option(
    '-s, --symbols <list>',
    'comma-separated universe override (default: momentum-universe.json)',
  )
  .action(async (opts: { symbols?: string }) => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date) ?? isoDateIst();
    const db = getDb();
    const universe = opts.symbols
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.toUpperCase());
    const result = runMomentumRanker({
      asOf: date,
      db,
      universe: universe?.length ? universe : undefined,
    });
    logger.info(result, 'momentum-rank complete');
    closeDb();
  });

program
  .command('momentum-rebalance')
  .description(
    'phase 4.2: regime gate → liquidate if non-bull → rank exits → entries (sector cap + blackout)',
  )
  .option(
    '-s, --symbols <list>',
    'comma-separated universe override for embedded ranker (default: momentum-universe.json)',
  )
  .option('--skip-ranker', 'use existing mom_rank signals for session (no ranker pass)')
  .option(
    '--skip-thesis',
    'skip LLM entry thesis (paper entries use ATR + hard-stop sizing only; for backfills / no API key)',
  )
  .option(
    '--brief',
    'compose skip-AI briefing with rebalance summary and deliver (same as Sunday scheduler)',
  )
  .action(
    async (opts: {
      symbols?: string;
      skipRanker?: boolean;
      brief?: boolean;
      skipThesis?: boolean;
    }) => {
      ensureDb();
      const date = optionalCliIsoDate(program.opts().date) ?? isoDateIst();
      const universe = opts.symbols
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.toUpperCase());
      const result = await runMomentumRebalance({
        calendarDate: date,
        universe: universe?.length ? universe : undefined,
        skipRanker: Boolean(opts.skipRanker),
        skipThesis: Boolean(opts.skipThesis),
      });
      logger.info(result, 'momentum-rebalance complete');
      if (opts.brief) {
        const summary = toMomentumRebalanceBriefingSummary(result);
        const closure = getMarketClosure(date);
        const briefing = await runBriefingComposer({
          date,
          skipAi: true,
          marketClosure: closure ?? undefined,
          momentumRebalanceSummary: summary,
          delivery: config.BRIEFING_DELIVERY,
        });
        await deliverBriefing(briefing.html, briefing.date, config.BRIEFING_DELIVERY);
        logger.info(
          { date: briefing.date, summaryPresent: summary != null },
          'momentum-rebalance briefing delivered',
        );
      }
      closeDb();
    },
  );

program
  .command('screen')
  .description("stage 3: run screens + alert scan against today's signals")
  .option('-n, --screen <name>', 'restrict to a single screen by name')
  .action(async (opts: { screen?: string }) => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date);
    const result = await runStockScreener({ date, screen: opts.screen });
    logger.info(result, 'screen complete');
    closeDb();
  });

program
  .command('backtest')
  .description('replay screens against historical EOD data and persist results')
  .requiredOption('-s, --start <YYYY-MM-DD>', 'inclusive start date of replay window')
  .requiredOption('-e, --end <YYYY-MM-DD>', 'inclusive end date of replay window')
  .option('-h, --hold-days <n>', 'trading sessions to hold each match', '10')
  .option('-n, --screen <name>', 'restrict to a single screen by name')
  .action(async (opts: { start: string; end: string; holdDays: string; screen?: string }) => {
    ensureDb();
    const summary = runBacktest({
      startDate: opts.start,
      endDate: opts.end,
      holdDays: Number(opts.holdDays) || 10,
      screenName: opts.screen,
    });
    for (const r of summary.results) {
      logger.info(
        {
          screen: r.screenName,
          runId: r.runId,
          trades: r.metrics.totalTrades,
          hitRate: r.metrics.hitRate,
          avgReturnPct: r.metrics.avgReturnPct,
          medianReturnPct: r.metrics.medianReturnPct,
          maxReturnPct: r.metrics.maxReturnPct,
          minReturnPct: r.metrics.minReturnPct,
          maxDrawdownPct: r.metrics.maxDrawdownPct,
        },
        'backtest result',
      );
    }
    closeDb();
  });

program
  .command('backtest-option-a')
  .description('Option A walk-forward backtest (momentum_mf / ai_pick rules, quotes-only signals)')
  .requiredOption('--strategy <id>', 'momentum-mf | ai-pick | all')
  .option('--from <YYYY-MM-DD>', 'inclusive start', '2023-01-01')
  .option('--to <YYYY-MM-DD>', 'inclusive end', '2026-03-31')
  .option('--min-history-days <n>', 'min quote sessions in window for full universe', '504')
  .option('--cost-bps <n>', 'round-trip transaction cost (bps), applied at exit', '20')
  .option(
    '--regime-source <mode>',
    'proxy (default): quotes-only coarse regime; daily: require regime_daily ≥80% coverage',
    'proxy',
  )
  .option('--dry-run', 'no DB writes; regime gate still enforced', false)
  .option('--verbose', 'extra progress logging (engine timing)', false)
  .action(
    async (opts: {
      strategy: string;
      from: string;
      to: string;
      minHistoryDays: string;
      costBps: string;
      dryRun?: boolean;
      verbose?: boolean;
      regimeSource?: string;
    }) => {
      const { runOptionABacktestJob } = await import('./backtest/runner.js');
      const s = opts.strategy.trim().toLowerCase();
      const strategy =
        s === 'momentum-mf' || s === 'momentum_mf'
          ? 'momentum-mf'
          : s === 'ai-pick' || s === 'ai_pick'
            ? 'ai-pick'
            : s === 'all'
              ? 'all'
              : null;
      if (!strategy) {
        logger.error({ strategy: opts.strategy }, 'unknown strategy');
        process.exitCode = 1;
        return;
      }
      const rs = (opts.regimeSource ?? 'proxy').trim().toLowerCase();
      const regimeSource = rs === 'daily' ? 'daily' : rs === 'proxy' ? 'proxy' : null;
      if (!regimeSource) {
        logger.error({ regimeSource: opts.regimeSource }, 'regime-source must be proxy or daily');
        process.exitCode = 1;
        return;
      }
      await runOptionABacktestJob({
        strategy,
        from: opts.from,
        to: opts.to,
        minHistoryDays: Number(opts.minHistoryDays) || 504,
        costBpsRoundTrip: Number(opts.costBps) || 20,
        dryRun: Boolean(opts.dryRun),
        verbose: Boolean(opts.verbose),
        regimeSource,
      });
    },
  );

program
  .command('concall')
  .description('fetch and analyse NSE concall transcripts for holdings/watchlist')
  .option('--symbol <symbol>', 'restrict to a single symbol')
  .option('--skip-fetch', 'skip PDF download, only run LLM analysis on existing transcripts')
  .action(async (opts: { symbol?: string; reanalyse?: boolean; skipFetch?: boolean }) => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date) ?? isoDateIst();
    const db = getDb();

    if (!opts.skipFetch) {
      const symbols = opts.symbol ? [opts.symbol.toUpperCase()] : undefined;
      const fetchResult = await fetchConcallTranscripts({ date, db, symbols });
      logger.info(fetchResult, 'concall fetch complete');
      console.log(JSON.stringify(fetchResult, null, 2));
    }

    const analysisResult = await analyseConcallTranscripts({}, db);
    logger.info(analysisResult, 'concall analysis complete');
    console.log(JSON.stringify(analysisResult, null, 2));
    closeDb();
  });

program
  .command('sentiment')
  .description('score unscored news headlines using the LLM provider')
  .option('-l, --limit <number>', 'max headlines to process', '100')
  .action(async (opts: { limit?: string }) => {
    ensureDb();
    const result = await enrichSentiment({ limit: Number(opts.limit) || 100 });
    logger.info(result, 'sentiment scoring complete');
    closeDb();
  });

program
  .command('thesis')
  .description('generate AI theses for top-signal watchlist stocks')
  .option('-n, --max <number>', 'max theses to generate', '5')
  .action(async (opts: { max?: string }) => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date);
    const result = await generateTheses({ date, maxTheses: Number(opts.max) || 5 });
    logger.info(
      { generated: result.generated, failed: result.failed },
      'thesis generation complete',
    );
    closeDb();
  });

program
  .command('brief')
  .description('stage 4: compose + deliver the daily briefing')
  .option('--delivery <method>', "override delivery method ('file' | 'email')")
  .option('--skip-ai', 'skip LLM narrative generation in the briefing')
  .action(async (opts: { delivery?: 'file' | 'email'; skipAi?: boolean }) => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date);
    const result = await runBriefingComposer({
      date,
      delivery: opts.delivery,
      skipAi: opts.skipAi,
    });
    await deliverBriefing(result.html, result.date, opts.delivery ?? config.BRIEFING_DELIVERY);
    closeDb();
  });

program
  .command('evaluate')
  .description('evaluate open paper trades against EOD quotes (SL / target / time-stop)')
  .option('--skip-ai', 'skip LLM post-mortem narratives for STOPPED_OUT rows')
  .action(async (opts: { skipAi?: boolean }) => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date) ?? isoDateIst();
    const result = runEvaluatePaperTrades(date, getDb(), { skipAi: Boolean(opts.skipAi) });
    logger.info(result, 'paper trade evaluation complete');
    closeDb();
  });

program
  .command('run-all')
  .description('alias for daily: full workflow + portfolio sync + all pipeline stages + briefing')
  .option('--skip-ai', 'skip all LLM stages (sentiment, thesis, narrative)')
  .action(async (opts: { skipAi?: boolean }) => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date) ?? isoDateIst();
    const result = await runDailyWorkflow({
      date,
      skipAi: opts.skipAi,
    });
    await deliverBriefing(result.html, result.date, config.BRIEFING_DELIVERY);
    logger.info(
      {
        date: result.date,
        delivery: config.BRIEFING_DELIVERY,
        portfolioCount: result.portfolioCount,
        thesesCount: result.thesesCount,
        screenMatchesCount: result.screenMatchesCount,
        alertCount: result.alertCount,
        holidayMode: result.holidayMode ?? false,
        marketClosureLabel: result.marketClosureLabel,
      },
      'run-all complete',
    );
    closeDb();
  });

program
  .command('daily')
  .description('one-shot: full pipeline + portfolio sync + per-holding LLM analysis')
  .option('--skip-ai', 'skip all LLM stages (sentiment, thesis, portfolio analysis)')
  .option('--skip-portfolio', 'skip portfolio sync + analysis (rest of pipeline runs)')
  .action(async (opts: { skipAi?: boolean; skipPortfolio?: boolean }) => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date);
    const result = await runDailyWorkflow({
      date,
      skipAi: opts.skipAi,
      skipPortfolio: opts.skipPortfolio,
    });
    await deliverBriefing(result.html, result.date, config.BRIEFING_DELIVERY);
    logger.info(
      {
        date: result.date,
        delivery: config.BRIEFING_DELIVERY,
        portfolioCount: result.portfolioCount,
        thesesCount: result.thesesCount,
        screenMatchesCount: result.screenMatchesCount,
        alertCount: result.alertCount,
        holidayMode: result.holidayMode ?? false,
        marketClosureLabel: result.marketClosureLabel,
      },
      'daily run complete',
    );
    closeDb();
  });

program
  .command('kite-login')
  .description('refresh Zerodha Kite Connect access_token (interactive)')
  .action(async () => {
    const result = await runKiteLogin();
    logger.info(
      { user: result.userId, name: result.userName, envPath: result.envPath },
      'kite access_token saved to .env',
    );
  });

program
  .command('portfolio-sync')
  .description('sync holdings from Kite (or config/portfolio.json) into the DB')
  .action(async () => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date);
    const result = await runPortfolioSync({ date });
    logger.info(result, 'portfolio sync done');
    closeDb();
  });

program
  .command('portfolio-analyse')
  .description('run LLM-driven HOLD/ADD/TRIM/EXIT analysis on each holding')
  .option('-s, --symbols <list>', 'comma-separated subset of holdings to analyse')
  .option('--min-position <inr>', 'skip holdings below this rupee value', '0')
  .option(
    '-j, --concurrency <n>',
    'parallel LLM calls (default: PORTFOLIO_ANALYSIS_CONCURRENCY from env)',
  )
  .action(async (opts: { symbols?: string; minPosition?: string; concurrency?: string }) => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date);
    const result = await analysePortfolio({
      date,
      symbols: opts.symbols
        ? opts.symbols.split(',').map((s) => s.trim().toUpperCase())
        : undefined,
      minPositionInr: Number(opts.minPosition) || 0,
      concurrency: opts.concurrency ? Number(opts.concurrency) : undefined,
    });
    logger.info(
      {
        analysed: result.analysed,
        failed: result.failed,
        byAction: result.byAction,
      },
      'portfolio analysis done',
    );
    closeDb();
  });

program
  .command('scan')
  .description('one-shot intraday LTP refresh via Kite (cron every 5-15 min)')
  .option('-t, --threshold <pct>', 'pct move that triggers a live alert', '3')
  .action(async (opts: { threshold?: string }) => {
    ensureDb();
    const result = await runLiveScan({
      alertThresholdPct: Number(opts.threshold) || 3,
    });
    logger.info(result, 'live scan done');
    closeDb();
  });

program
  .command('schedule')
  .description('start croner schedule (08:45 / 16:30 weekdays, Sat 08:00 IST)')
  .option('--run-now', 'run one cycle immediately on startup')
  .action(async (opts: { runNow?: boolean }) => {
    ensureDb();
    if (opts.runNow) {
      const now = await runDailyWorkflow();
      await deliverBriefing(now.html, now.date, config.BRIEFING_DELIVERY);
      logger.info({ date: now.date }, 'initial run-now cycle complete');
      closeDb();
    }
    const handle = startScheduler();
    process.on('SIGINT', () => {
      handle.stop();
      closeDb();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      handle.stop();
      closeDb();
      process.exit(0);
    });
    await new Promise<void>(() => {
      // Intentionally never resolved; process exits on SIGINT/SIGTERM handlers.
    });
  });

program
  .command('ext-signal-smoke')
  .description(
    'sync portfolio, ingest external signal holdings, print overlap vs your holdings (live API)',
  )
  .option(
    '--skip-portfolio-sync',
    'use latest portfolio_holdings snapshot instead of running portfolio sync',
  )
  .action(async (opts: { skipPortfolioSync?: boolean }) => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date) ?? isoDateIst();
    try {
      const result = await runExtSignalSmoke({
        date,
        skipPortfolioSync: Boolean(opts.skipPortfolioSync),
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.ingest.skipped) {
        logger.error({ skipReason: result.ingest.skipReason }, 'ext-signal-smoke skipped');
        process.exitCode = 1;
        return;
      }
      if (result.ingest.strategiesSucceeded === 0) {
        logger.error('ext-signal-smoke: no strategies ingested successfully');
        process.exitCode = 1;
      }
    } finally {
      closeDb();
    }
  });

program
  .command('fundamental-screen-audit')
  .description('audit quality_at_value / dividend_compounder pass rates and bottlenecks')
  .action(() => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date) ?? isoDateIst();
    try {
      const result = runFundamentalScreenAudit({ date });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      closeDb();
    }
  });

program
  .command('ext-signal-cross-ref')
  .description('overlap ext_signal_holdings vs watchlist, momentum ranks, portfolio, paper trades')
  .action(() => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date) ?? isoDateIst();
    try {
      const result = runExtSignalCrossRef({ date });
      console.log(JSON.stringify(result, null, 2));
      if (result.summary.extSignalSymbols === 0) {
        logger.warn(
          'no ext_signal_holdings rows — run ext-signal-smoke after setting EXT_SIGNAL_* env vars',
        );
      }
    } finally {
      closeDb();
    }
  });

program
  .command('gate-audit')
  .description('query strategy gate audit trail (why screens/strategies were allowed/blocked)')
  .option('--date <YYYY-MM-DD>', 'restrict to a specific date')
  .option('--from <YYYY-MM-DD>', 'inclusive start date')
  .option('--to <YYYY-MM-DD>', 'inclusive end date')
  .option('--strategy <id>', 'filter by strategy id (e.g. quality_garp, momentum_mf)')
  .option('--symbol <symbol>', 'filter by symbol')
  .option('-n, --limit <n>', 'max rows (default 50)', '50')
  .option('--summary', 'show aggregate summary per strategy instead of raw rows')
  .action(async (opts: { date?: string; from?: string; to?: string; strategy?: string; symbol?: string; limit?: string; summary?: boolean }) => {
    ensureDb();
    const db = getDb();
    if (opts.summary) {
      const date = opts.date ?? optionalCliIsoDate(program.opts().date) ?? isoDateIst();
      const summary = getGateAuditSummary(date, db);
      console.log(JSON.stringify({ date, summary }, null, 2));
    } else {
      const rows = queryGateAudit(
        {
          date: opts.date,
          fromDate: opts.from,
          toDate: opts.to,
          strategyId: opts.strategy,
          symbol: opts.symbol,
          limit: Number(opts.limit) || 50,
        },
        db,
      );
      console.log(JSON.stringify({ count: rows.length, rows }, null, 2));
    }
    closeDb();
  });

program
  .command('stage-history')
  .description('query pipeline stage results for the trailing N days (default 7)')
  .argument('<stage>', 'pipeline stage name (e.g. yahoo-snapshot)')
  .option('-n, --days <n>', 'trailing days to inspect')
  .action((stage: string, opts: { days?: string }) => {
    ensureDb();
    const rows = getStageHistory(stage, opts.days ? Number(opts.days) : undefined, getDb());
    const effectiveDays = opts.days ? Number(opts.days) : 7;
    console.log(JSON.stringify({ stage, days: effectiveDays, runs: rows.length, rows }, null, 2));
    closeDb();
  });

program
  .command('doctor')
  .description('print runtime + config diagnostics (no secrets)')
  .action(async () => {
    const summary = {
      app: { name: APP_NAME, version: APP_VERSION },
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        tz: config.TZ,
      },
      pipeline: {
        marketDataProvider: config.MARKET_DATA_PROVIDER,
        llmProvider: config.LLM_PROVIDER,
        vertexModel: config.LLM_PROVIDER === 'vertex' ? config.VERTEX_MODEL : undefined,
        portfolioAnalysisConcurrency: config.PORTFOLIO_ANALYSIS_CONCURRENCY,
        briefingDelivery: config.BRIEFING_DELIVERY,
        databasePath: config.DATABASE_PATH,
        nodeEnv: config.NODE_ENV,
        logLevel: config.LOG_LEVEL,
      },
      secrets: {
        anthropic: redact(config.ANTHROPIC_API_KEY),
        openai: redact(config.OPENAI_API_KEY),
        kite: {
          apiKey: redact(config.KITE_API_KEY),
          accessToken: redact(config.KITE_ACCESS_TOKEN),
        },
        googleApplicationCredentials: redact(config.GOOGLE_APPLICATION_CREDENTIALS),
        smtp: redact(config.SMTP_USER),

        extSignalEndpoint: redact(process.env.EXT_SIGNAL_ENDPOINT),
        extSignalApiKey: redact(process.env.EXT_SIGNAL_API_KEY),
        vertexProject: config.GOOGLE_VERTEX_PROJECT ? 'set' : 'missing',
      },
    };
    console.log(JSON.stringify(summary, null, 2));
  });

function redact(value: string | undefined): 'set' | 'missing' {
  return value && value.length > 0 ? 'set' : 'missing';
}

function ensureDb(): void {
  // Touch the DB so missing schema is reported early. Migrations are
  // idempotent so this is cheap.
  getDb();
  migrate();
}

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    logger.error({ err }, 'cli command failed');
    process.exitCode = 1;
  }
}

void main();
