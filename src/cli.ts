#!/usr/bin/env node
/**
 * Market Pulse AI - CLI entry point.
 *
 * Subcommands map 1:1 to pipeline stages so each can be run in isolation:
 *
 *   mp migrate           Apply DB migrations
 *   mp ingest            Stage 1 - pull data from configured sources
 *   mp enrich            Stage 2 - compute signals from raw data
 *   mp momentum-rank     Phase 4.1 - momentum composite + ranks (signals)
 *   mp screen            Stage 3 - run screens + alert scan against today's signals
 *   mp backtest          Replay screens against historical EOD data
 *   mp sentiment         Score news headlines via LLM
 *   mp thesis            Generate AI theses for top-signal stocks
 *   mp evaluate           Mark outcomes for open paper trades vs EOD quotes
 *   mp run-all           Full pipeline (ingest → enrich → regime → screen → thesis → brief)
 *   mp daily             One-shot: full pipeline + portfolio analysis (recommended)
 *   mp sync-sectors      Cache Yahoo sector/industry in `symbols` (for portfolio sector rollup)
 *   mp kite-login        Refresh Zerodha Kite Connect access_token (run daily)
 *   mp kite-verify       GET portfolio/holdings — verify API key + access_token (same as sync)
 *   mp portfolio-sync    Pull holdings from Kite (or manual) into the DB
 *   mp portfolio-analyse Run LLM-driven HOLD/ADD/TRIM/EXIT analysis per holding
 *   mp scan              One-shot intraday LTP refresh via Kite (cron-able)
 *   mp schedule          Start croner jobs (07:30 / 15:30 weekdays, Sat 08:00, Sun 06:00 earnings)
 *   mp doctor            Print runtime/config diagnostics
 *   mp regime            Full regime agent (classify + LLM narrative → regime_daily)
 *   mp regime:classify   Deterministic regime only (narrative null)
 *   mp regime:gate-summary  Print allowed strategies for today's regime
 *   mp regime-signals    Print regime inputs + scores for a date (validation)
 * Run `mp --help` or `mp <cmd> --help` for full options.
 */

import { Command } from 'commander';
import { runBacktester } from './agents/backtester.js';
import { runBriefingComposer } from './agents/briefing-composer.js';
import { runDailyIngestor } from './agents/daily-ingestor.js';
import { runDailyWorkflow } from './agents/daily-workflow.js';
import { runLiveScan } from './agents/live-scanner.js';
import { analysePortfolio } from './agents/portfolio-analyser.js';
import { runPortfolioSync } from './agents/portfolio-sync.js';
import { runRegimeAgent } from './agents/regime-agent.js';
import { runSignalEnricher } from './agents/signal-enricher.js';
import { runStockScreener } from './agents/stock-screener.js';
import { generateTheses } from './agents/thesis-generator.js';
import { runRegimeClassifier } from './analysers/regime-classifier.js';
import { deliverToEmail, deliverToFile } from './briefing/index.js';
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
import { computeRegimeSignals } from './enrichers/regime-signals.js';
import { enrichSentiment } from './enrichers/sentiment/enricher.js';
import { isoDateIst, optionalCliIsoDate } from './ingestors/base/dates.js';
import { runKiteLogin } from './ingestors/kite/auth.js';
import { KiteApiError, KiteClient } from './ingestors/kite/client.js';
import { logger } from './logger.js';
import { defaultIngestSymbolUniverse } from './market/ingest-symbols.js';
import { getMarketClosure } from './market/nse-calendar.js';
import { syncSymbolSectorsFromYahoo } from './market/yahoo-sectors.js';
import { runMomentumRanker } from './rankers/momentum-ranker.js';
import { startScheduler } from './scheduler/market-scheduler.js';
import { runEvaluatePaperTrades } from './scripts/evaluate-trades.js';

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
  .command('regime-signals')
  .description('print regime signal inputs + weighted scores for validation (Phase 1)')
  .action(async () => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date) ?? isoDateIst();
    const signals = computeRegimeSignals(getDb(), date);
    console.log(JSON.stringify(signals, null, 2));
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
  .command('regime:classify')
  .description('deterministic regime only → regime_daily (narrative null; for backfill)')
  .action(async () => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date);
    const result = runRegimeClassifier({ date });
    logger.info(
      { regime: result.regime, rawRegime: result.rawRegime, crisis: result.crisisOverride },
      'regime classified (deterministic)',
    );
    console.log(JSON.stringify(result, null, 2));
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
  .option('-s, --symbols <list>', 'comma-separated list of symbols')
  .action(async (opts: { symbols?: string }) => {
    ensureDb();
    const symbols = opts.symbols
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
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
    const universe = opts.symbols
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.toUpperCase());
    const result = runMomentumRanker({
      asOf: date,
      universe: universe?.length ? universe : undefined,
    });
    logger.info(result, 'momentum-rank complete');
    closeDb();
  });

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
    const summary = await runBacktester({
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
  .option(
    '--delivery <method>',
    "override delivery method ('file' | 'email' | 'slack' | 'telegram')",
  )
  .option('--skip-ai', 'skip LLM narrative generation in the briefing')
  .action(
    async (opts: { delivery?: 'file' | 'email' | 'slack' | 'telegram'; skipAi?: boolean }) => {
      ensureDb();
      const date = optionalCliIsoDate(program.opts().date);
      const result = await runBriefingComposer({
        date,
        delivery: opts.delivery,
        skipAi: opts.skipAi,
      });
      await deliverBriefing(result.html, result.date, opts.delivery ?? config.BRIEFING_DELIVERY);
      closeDb();
    },
  );

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
  .description(
    'run full pipeline: ingest -> enrich -> regime -> gated screen -> sentiment -> thesis -> brief',
  )
  .option('--skip-ai', 'skip all LLM stages (sentiment, thesis, narrative)')
  .action(async (opts: { skipAi?: boolean }) => {
    ensureDb();
    const date = optionalCliIsoDate(program.opts().date) ?? isoDateIst();
    const closure = getMarketClosure(date);
    if (closure) {
      const result = await runBriefingComposer({
        date,
        skipAi: true,
        marketClosure: closure,
        delivery: config.BRIEFING_DELIVERY,
      });
      await deliverBriefing(result.html, result.date, config.BRIEFING_DELIVERY);
      logger.info(
        { date: result.date, delivery: result.delivery, holiday: closure.label },
        'pipeline complete (market closed)',
      );
      closeDb();
      return;
    }

    await runDailyIngestor({ date });
    await runSignalEnricher({ date });
    const regimeAgent = await runRegimeAgent({ date, skipLlm: Boolean(opts.skipAi) });
    await runStockScreener({ date, regime: regimeAgent.regime });

    let thesisRun:
      | {
          generated: number;
          failed: number;
          candidateCount: number;
          eligibleUniverseSize: number;
          watchlistSize: number;
        }
      | undefined;

    if (!opts.skipAi) {
      const sentimentResult = await enrichSentiment();
      logger.info(sentimentResult, 'sentiment scoring done');

      const thesisResult = await generateTheses({ date, regime: regimeAgent.regime });
      thesisRun = {
        generated: thesisResult.generated,
        failed: thesisResult.failed,
        candidateCount: thesisResult.candidateCount,
        eligibleUniverseSize: thesisResult.eligibleUniverseSize,
        watchlistSize: thesisResult.watchlistSize,
      };
      logger.info(
        { generated: thesisResult.generated, failed: thesisResult.failed },
        'thesis generation done',
      );
    }

    const result = await runBriefingComposer({
      date,
      skipAi: opts.skipAi,
      thesisRun: opts.skipAi ? undefined : thesisRun,
      delivery: config.BRIEFING_DELIVERY,
    });
    await deliverBriefing(result.html, result.date, config.BRIEFING_DELIVERY);
    logger.info({ date: result.date, delivery: result.delivery }, 'pipeline complete');
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
  .command('kite-verify')
  .description(
    'call GET portfolio/holdings using .env (same auth as portfolio-sync); prints errors from Kite',
  )
  .action(async () => {
    const client = new KiteClient();
    if (!client.hasSession()) {
      logger.error(
        'KITE_API_KEY and KITE_ACCESS_TOKEN must be set. Run `pnpm cli kite-login` first.',
      );
      process.exitCode = 1;
      return;
    }
    try {
      const holdings = await client.getHoldings();
      logger.info(
        {
          apiBase: config.KITE_API_BASE,
          holdingsCount: holdings.length,
          sampleSymbols: holdings.slice(0, 5).map((h) => h.tradingsymbol),
        },
        'Kite verify OK — portfolio/holdings succeeded',
      );
    } catch (err) {
      if (err instanceof KiteApiError) {
        logger.error(
          {
            message: err.message,
            errorType: err.errorType,
            httpStatus: err.statusCode,
            treatedAsExpiredToken: err.isTokenExpired(),
          },
          'Kite verify failed (same request portfolio-sync uses)',
        );
      } else {
        logger.error({ err }, 'Kite verify failed');
      }
      process.exitCode = 1;
    }
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
  .description('start croner schedule (07:30 / 15:30 weekdays, Sat 08:00 IST)')
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

async function deliverBriefing(
  html: string,
  date: string,
  method: 'file' | 'email' | 'slack' | 'telegram',
): Promise<void> {
  if (method === 'file') {
    deliverToFile(html, date);
    return;
  }
  if (method === 'email') {
    await deliverToEmail(html, date);
    return;
  }
  logger.warn(
    { delivery: method },
    'delivery channel not implemented yet - briefing not delivered',
  );
}

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
        slack: redact(config.SLACK_WEBHOOK_URL),
        telegram: redact(config.TELEGRAM_BOT_TOKEN),
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
