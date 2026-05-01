/**
 * Reusable full daily workflow orchestration.
 *
 * Shared by:
 *  - `mp daily`
 *  - scheduler jobs (`mp schedule`)
 */

import { config } from '../config/env.js';
import { enrichSentiment } from '../enrichers/sentiment/enricher.js';
import { child } from '../logger.js';
import { runBriefingComposer } from './briefing-composer.js';
import { runDailyIngestor } from './daily-ingestor.js';
import { analysePortfolio } from './portfolio-analyser.js';
import { runPortfolioSync } from './portfolio-sync.js';
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
}

export async function runDailyWorkflow(
  opts: DailyWorkflowOptions = {},
): Promise<DailyWorkflowResult> {
  await runDailyIngestor({ date: opts.date });
  await runSignalEnricher({ date: opts.date });
  await runStockScreener({ date: opts.date });

  if (!opts.skipPortfolio) {
    try {
      await runPortfolioSync({ date: opts.date });
      const stopLoss = detectStopLossBreaches({ date: opts.date });
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

  if (!opts.skipAi) {
    const sentimentResult = await enrichSentiment();
    log.info(sentimentResult, 'sentiment scoring done');

    const thesisResult = await generateTheses({ date: opts.date });
    log.info(
      { generated: thesisResult.generated, failed: thesisResult.failed },
      'thesis generation done',
    );

    if (!opts.skipPortfolio) {
      const portfolioResult = await analysePortfolio({ date: opts.date });
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
    date: opts.date,
    skipAi: opts.skipAi,
    delivery: config.BRIEFING_DELIVERY,
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
