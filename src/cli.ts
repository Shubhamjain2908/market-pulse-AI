#!/usr/bin/env node
/**
 * Market Pulse AI - CLI entry point.
 *
 * Subcommands map 1:1 to pipeline stages so each can be run in isolation:
 *
 *   mp migrate           Apply DB migrations
 *   mp ingest            Stage 1 - pull data from configured sources
 *   mp enrich            Stage 2 - compute signals from raw data
 *   mp screen            Stage 3 - apply screens to signals
 *   mp sentiment         Score news headlines via LLM
 *   mp thesis            Generate AI theses for top-signal stocks
 *   mp brief             Stage 4 - compose + deliver briefing
 *   mp run-all           Run full pipeline (ingest -> brief)
 *   mp doctor            Print runtime/config diagnostics
 *
 * Run `mp --help` or `mp <cmd> --help` for full options.
 */

import { Command } from 'commander';
import { runBriefingComposer } from './agents/briefing-composer.js';
import { runDailyIngestor } from './agents/daily-ingestor.js';
import { runSignalEnricher } from './agents/signal-enricher.js';
import { runStockScreener } from './agents/stock-screener.js';
import { generateTheses } from './agents/thesis-generator.js';
import { deliverToFile } from './briefing/index.js';
import { config } from './config/env.js';
import { APP_NAME, APP_VERSION } from './constants.js';
import { closeDb, getDb, migrate } from './db/index.js';
import { enrichSentiment } from './enrichers/sentiment/enricher.js';
import { logger } from './logger.js';

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
  .command('ingest')
  .description('stage 1: pull market data from configured sources')
  .option('-s, --symbols <list>', 'comma-separated list of symbols')
  .action(async (opts: { symbols?: string }) => {
    ensureDb();
    const symbols = opts.symbols
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const date = program.opts<{ date?: string }>().date;
    const result = await runDailyIngestor({ date, symbols });
    logger.info(result, 'ingest complete');
    closeDb();
  });

program
  .command('enrich')
  .description('stage 2: compute technical + fundamental signals')
  .option('-s, --symbols <list>', 'comma-separated list of symbols')
  .action(async (opts: { symbols?: string }) => {
    ensureDb();
    const symbols = opts.symbols
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const date = program.opts<{ date?: string }>().date;
    const result = await runSignalEnricher({ date, symbols });
    logger.info(result, 'enrich complete');
    closeDb();
  });

program
  .command('screen')
  .description('stage 3: evaluate screens against the signals table')
  .option('-n, --screen <name>', 'restrict to a single screen by name')
  .action(async (opts: { screen?: string }) => {
    ensureDb();
    const date = program.opts<{ date?: string }>().date;
    const result = await runStockScreener({ date, screen: opts.screen });
    logger.info(result, 'screen complete');
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
    const date = program.opts<{ date?: string }>().date;
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
      const date = program.opts<{ date?: string }>().date;
      const result = await runBriefingComposer({
        date,
        delivery: opts.delivery,
        skipAi: opts.skipAi,
      });
      deliverBriefing(result.html, result.date, opts.delivery ?? config.BRIEFING_DELIVERY);
      closeDb();
    },
  );

program
  .command('run-all')
  .description('run full pipeline: ingest -> enrich -> sentiment -> thesis -> brief')
  .option('--skip-ai', 'skip all LLM stages (sentiment, thesis, narrative)')
  .action(async (opts: { skipAi?: boolean }) => {
    ensureDb();
    const date = program.opts<{ date?: string }>().date;

    await runDailyIngestor({ date });
    await runSignalEnricher({ date });
    await runStockScreener({ date });

    if (!opts.skipAi) {
      const sentimentResult = await enrichSentiment();
      logger.info(sentimentResult, 'sentiment scoring done');

      const thesisResult = await generateTheses({ date });
      logger.info(
        { generated: thesisResult.generated, failed: thesisResult.failed },
        'thesis generation done',
      );
    }

    const result = await runBriefingComposer({ date, skipAi: opts.skipAi });
    deliverBriefing(result.html, result.date, config.BRIEFING_DELIVERY);
    logger.info({ date: result.date, delivery: result.delivery }, 'pipeline complete');
    closeDb();
  });

/**
 * Phase 1 supports the `file` channel. Other channels log a warning and
 * skip - real implementations (Gmail SMTP, Slack, Telegram) land in
 * Phase 4.
 */
function deliverBriefing(
  html: string,
  date: string,
  method: 'file' | 'email' | 'slack' | 'telegram',
): void {
  if (method !== 'file') {
    logger.warn(
      { delivery: method },
      'non-file delivery not implemented yet - briefing not delivered',
    );
    return;
  }
  deliverToFile(html, date);
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
        briefingDelivery: config.BRIEFING_DELIVERY,
        databasePath: config.DATABASE_PATH,
        nodeEnv: config.NODE_ENV,
        logLevel: config.LOG_LEVEL,
      },
      secrets: {
        anthropic: redact(config.ANTHROPIC_API_KEY),
        openai: redact(config.OPENAI_API_KEY),
        kite: redact(config.KITE_API_KEY),
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
