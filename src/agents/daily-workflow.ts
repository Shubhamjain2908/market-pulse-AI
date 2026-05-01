/**
 * Reusable full daily workflow orchestration.
 *
 * Shared by:
 *  - `mp daily`
 *  - scheduler jobs (`mp schedule`)
 */

import { config } from '../config/env.js';
import { enrichSentiment } from '../enrichers/sentiment/enricher.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { child } from '../logger.js';
import { getMarketClosure } from '../market/nse-calendar.js';
import { runBriefingComposer } from './briefing-composer.js';
import { runDailyIngestor } from './daily-ingestor.js';
import { analysePortfolio } from './portfolio-analyser.js';
import { runPortfolioSync } from './portfolio-sync.js';
import { maybeWriteDailyRunSummary } from './run-summary.js';
import { runSignalEnricher } from './signal-enricher.js';
import { runStockScreener } from './stock-screener.js';
import { detectStopLossBreaches } from './stop-loss-detector.js';
import { generateTheses } from './thesis-generator.js';

const log = child({ component: 'daily-workflow' });

export interface DailyWorkflowOptions {
  date?: string;
  skipAi?: boolean;
  skipPortfolio?: boolean;
}

export interface DailyWorkflowResult {
  date: string;
  alertCount: number;
  screenMatchesCount: number;
  newsCount: number;
  thesesCount: number;
  portfolioCount: number;
  hasNarrative: boolean;
  html: string;
  delivery: 'file' | 'email' | 'slack' | 'telegram';
  /** True when `date` was a weekend or NSE holiday — no ingest / enrichment / fresh LLMs ran. */
  holidayMode?: boolean;
  /** Human-readable closure label when `holidayMode` is true. */
  marketClosureLabel?: string;
}

export async function runDailyWorkflow(
  opts: DailyWorkflowOptions = {},
): Promise<DailyWorkflowResult> {
  const date = opts.date ?? isoDateIst();
  const closure = getMarketClosure(date);

  if (closure) {
    log.info(
      { date, closure },
      'market closed — persisted-data brief only (no ingest / fresh LLMs)',
    );
    const briefing = await runBriefingComposer({
      date,
      skipAi: true,
      marketClosure: closure,
      delivery: config.BRIEFING_DELIVERY,
    });
    maybeWriteDailyRunSummary({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      date: briefing.date,
      holidayMode: true,
      marketClosureLabel: closure.label,
      delivery: briefing.delivery,
      counts: {
        alerts: briefing.alertCount,
        screenMatchSymbols: briefing.screenMatchesCount,
        news: briefing.newsCount,
        theses: briefing.thesesCount,
        portfolioHoldings: briefing.portfolioCount,
      },
      hasMoodNarrative: briefing.hasNarrative,
    });
    return {
      date: briefing.date,
      alertCount: briefing.alertCount,
      screenMatchesCount: briefing.screenMatchesCount,
      newsCount: briefing.newsCount,
      thesesCount: briefing.thesesCount,
      portfolioCount: briefing.portfolioCount,
      hasNarrative: briefing.hasNarrative,
      html: briefing.html,
      delivery: config.BRIEFING_DELIVERY,
      holidayMode: true,
      marketClosureLabel: closure.label,
    };
  }

  if (!opts.skipPortfolio) {
    try {
      await runPortfolioSync({ date });
      const stopLoss = detectStopLossBreaches({ date });
      log.info(
        { checked: stopLoss.checked, breached: stopLoss.breached },
        'stop-loss detector complete',
      );
    } catch (err) {
      log.warn(
        { err: (err as Error).message },
        'portfolio sync/stop-loss failed; continuing workflow',
      );
    }
  }

  await runDailyIngestor({ date });
  await runSignalEnricher({ date });
  await runStockScreener({ date });

  let thesisRun: { generated: number; failed: number; candidateCount: number } | undefined;

  if (!opts.skipAi) {
    const sentimentResult = await enrichSentiment();
    log.info(sentimentResult, 'sentiment scoring done');

    const thesisResult = await generateTheses({ date, maxTheses: config.THESIS_MAX_PER_RUN });
    thesisRun = {
      generated: thesisResult.generated,
      failed: thesisResult.failed,
      candidateCount: thesisResult.candidateCount,
    };
    log.info(
      { generated: thesisResult.generated, failed: thesisResult.failed },
      'thesis generation done',
    );

    if (!opts.skipPortfolio) {
      const portfolioResult = await analysePortfolio({ date });
      log.info(
        {
          analysed: portfolioResult.analysed,
          failed: portfolioResult.failed,
          byAction: portfolioResult.byAction,
        },
        'portfolio analysis done',
      );
    }
  }

  const briefing = await runBriefingComposer({
    date,
    skipAi: opts.skipAi,
    thesisRun: opts.skipAi ? undefined : thesisRun,
    delivery: config.BRIEFING_DELIVERY,
  });

  maybeWriteDailyRunSummary({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    date: briefing.date,
    holidayMode: false,
    delivery: briefing.delivery,
    counts: {
      alerts: briefing.alertCount,
      screenMatchSymbols: briefing.screenMatchesCount,
      news: briefing.newsCount,
      theses: briefing.thesesCount,
      portfolioHoldings: briefing.portfolioCount,
    },
    thesisRun: opts.skipAi ? undefined : thesisRun,
    hasMoodNarrative: briefing.hasNarrative,
  });

  return {
    date: briefing.date,
    alertCount: briefing.alertCount,
    screenMatchesCount: briefing.screenMatchesCount,
    newsCount: briefing.newsCount,
    thesesCount: briefing.thesesCount,
    portfolioCount: briefing.portfolioCount,
    hasNarrative: briefing.hasNarrative,
    html: briefing.html,
    delivery: config.BRIEFING_DELIVERY,
  };
}
