/**
 * Reusable full daily workflow orchestration.
 *
 * Shared by:
 *  - `mp daily`
 *  - scheduler jobs (`mp schedule`)
 */

import type { WarningEntry } from '../briefing/template.js';
import { config } from '../config/env.js';
import { getMomentumUniverseSymbols } from '../config/loaders.js';
import { getDb } from '../db/index.js';
import { enrichSentiment } from '../enrichers/sentiment/enricher.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { applyCorporateActionsFromYahooSplits } from '../ingestors/corporate-actions.js';
import { ingestYahooSnapshots } from '../ingestors/yahoo-snapshot-ingestor.js';
import { syncMomentumEarningsCalendarFromYahoo } from '../ingestors/yahoo/earnings-ingestor.js';
import { child } from '../logger.js';
import { getMarketClosure, isSundayIst } from '../market/nse-calendar.js';
import { runEvaluatePaperTrades } from '../scripts/evaluate-trades.js';
import { applyMomentumRegimeGateExits } from '../strategies/momentum-rebalance.js';
import { runBriefingComposer } from './briefing-composer.js';
import { runDailyIngestor } from './daily-ingestor.js';
import { analysePortfolio } from './portfolio-analyser.js';
import { runPortfolioSync } from './portfolio-sync.js';
import { runRegimeAgent } from './regime-agent.js';
import { maybeWriteDailyRunSummary } from './run-summary.js';
import { runSignalEnricher } from './signal-enricher.js';
import { runStockScreener } from './stock-screener.js';
import { detectStopLossBreaches } from './stop-loss-detector.js';
import { generateTheses } from './thesis-generator.js';

const log = child({ component: 'daily-workflow' });

export interface DailyWorkflowOptions {
  /** ISO date (YYYY-MM-DD). Defaults to today IST. */
  date?: string;
  /** Skip AI-powered stages (thesis, portfolio analysis, mood narrative). */
  skipAi?: boolean;
  /** Skip portfolio sync and stop-loss detection. */
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

  if (isSundayIst(date)) {
    try {
      await syncMomentumEarningsCalendarFromYahoo(
        getMomentumUniverseSymbols({ fresh: true }),
        getDb(),
        { refDate: date },
      );
    } catch (err) {
      log.warn(
        { err: (err as Error).message },
        'Sunday Yahoo earnings calendar refresh failed; continuing',
      );
    }
  }

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

  const warnings: WarningEntry[] = [];

  if (!opts.skipPortfolio) {
    try {
      // Phase 4.5: portfolio sync + stop-loss are outside regime gates (`portfolio_exit_signals` /
      // `trailing_stop_update` are always-on at 100% in strategy-gates.json).
      await runPortfolioSync({ date });
      const stopLoss = detectStopLossBreaches({ date });
      log.info(
        { checked: stopLoss.checked, breached: stopLoss.breached },
        'stop-loss detector complete',
      );
    } catch (err) {
      const msg = (err as Error).message;
      log.warn({ err: msg }, 'portfolio sync/stop-loss failed; continuing workflow');
      warnings.push({ category: 'Portfolio sync', message: msg });
    }
  }

  const ingestResult = await runDailyIngestor({ date });
  for (const f of ingestResult.failures) {
    warnings.push({
      category: 'Ingest',
      message: `${f.ingestor} could not fetch ${f.capability}: ${f.reason}`,
    });
  }

  try {
    await applyCorporateActionsFromYahooSplits(getDb(), { refDate: date });
  } catch (err) {
    const msg = (err as Error).message;
    log.warn({ err: msg }, 'corporate actions from Yahoo splits failed; continuing workflow');
    warnings.push({ category: 'Corporate actions', message: msg });
  }
  await runSignalEnricher({ date });
  try {
    const snap = await ingestYahooSnapshots(getDb(), { date });
    if (snap.failed > 0) {
      log.warn(snap, 'yahoo snapshot ingest partial failures');
    } else {
      log.info(snap, 'yahoo snapshot ingest complete');
    }
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      'yahoo snapshot ingest failed unexpectedly; continuing workflow',
    );
  }
  const regimeAgent = await runRegimeAgent({ date, skipLlm: Boolean(opts.skipAi) });
  const momRegimeExits = applyMomentumRegimeGateExits({
    calendarDate: date,
    regime: regimeAgent.regime,
    db: getDb(),
  });
  if (momRegimeExits > 0) {
    log.info({ momRegimeExits }, 'momentum regime gate: closed paper trades');
  }
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
    log.info(sentimentResult, 'sentiment scoring done');
    if (sentimentResult.scored === 0 && sentimentResult.failed > 0) {
      warnings.push({
        category: 'Sentiment',
        message: `News sentiment scoring completed with ${sentimentResult.failed} error(s) and no successfully scored items.`,
      });
    }

    const thesisResult = await generateTheses({
      date,
      maxTheses: config.THESIS_MAX_PER_RUN,
      regime: regimeAgent.regime,
    });
    thesisRun = {
      generated: thesisResult.generated,
      failed: thesisResult.failed,
      candidateCount: thesisResult.candidateCount,
      eligibleUniverseSize: thesisResult.eligibleUniverseSize,
      watchlistSize: thesisResult.watchlistSize,
    };
    log.info(
      { generated: thesisResult.generated, failed: thesisResult.failed },
      'thesis generation done',
    );

    if (!opts.skipPortfolio) {
      const portfolioResult = await analysePortfolio({ date });
      if (portfolioResult.failed > 0) {
        warnings.push({
          category: 'Portfolio analysis',
          message: `${portfolioResult.failed} holding(s) failed AI analysis after retries; check LLM provider status. ${portfolioResult.analysed} holding(s) completed successfully.`,
        });
      }
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

  const paperEval = runEvaluatePaperTrades(date, getDb(), { skipAi: opts.skipAi });
  log.info(paperEval, 'paper trade evaluation');

  const briefing = await runBriefingComposer({
    date,
    skipAi: opts.skipAi,
    thesisRun: opts.skipAi ? undefined : thesisRun,
    delivery: config.BRIEFING_DELIVERY,
    warnings: warnings.length > 0 ? warnings : undefined,
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
