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
import { recordPipelineStage } from '../db/pipeline-queries.js';
import { enrichSentiment } from '../enrichers/sentiment/enricher.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { applyCorporateActionsFromYahooSplits } from '../ingestors/corporate-actions.js';
import { runExtSignalHoldingsIngestor } from '../ingestors/ext-signal-holdings-ingestor.js';
import { fetchInavSnapshots } from '../ingestors/inav-fetcher.js';
import { syncMomentumEarningsCalendarFromYahoo } from '../ingestors/yahoo/earnings-ingestor.js';
import { ingestYahooSnapshots } from '../ingestors/yahoo-snapshot-ingestor.js';
import { clearRunBudget, LlmBudgetExceededError, startRunBudget } from '../llm/index.js';
import { child } from '../logger.js';
import { getMarketClosure, isSundayIst } from '../market/nse-calendar.js';
import { type EvaluateTradesResult, runEvaluatePaperTrades } from '../scripts/evaluate-trades.js';
import { applyMomentumRegimeGateExits } from '../strategies/momentum-rebalance.js';
import { type BriefRunResult, runBriefingComposer } from './briefing-composer.js';
import { type IngestRunResult, runDailyIngestor } from './daily-ingestor.js';
import { analysePortfolio } from './portfolio-analyser.js';
import { runPortfolioSync } from './portfolio-sync.js';
import { type RunRegimeAgentResult, runRegimeAgent } from './regime-agent.js';
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
    const sundayDb = getDb();
    recordPipelineStage({ runDate: date, stage: 'earnings-calendar', status: 'started' }, sundayDb);
    try {
      await syncMomentumEarningsCalendarFromYahoo(
        getMomentumUniverseSymbols({ fresh: true }),
        sundayDb,
        { refDate: date },
      );
      recordPipelineStage(
        { runDate: date, stage: 'earnings-calendar', status: 'success' },
        sundayDb,
      );
    } catch (err) {
      recordPipelineStage(
        {
          runDate: date,
          stage: 'earnings-calendar',
          status: 'failed',
          errorMsg: (err as Error).message,
        },
        sundayDb,
      );
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
    let briefing: BriefRunResult;
    try {
      briefing = await runBriefingComposer({
        date,
        skipAi: true,
        marketClosure: closure,
        delivery: config.BRIEFING_DELIVERY,
      });
    } catch (err) {
      recordPipelineStage(
        {
          runDate: date,
          stage: 'briefing',
          status: 'failed',
          errorMsg: (err as Error).message,
        },
        getDb(),
      );
      throw err;
    }
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
  let budgetExceeded = false;

  if (!opts.skipAi) {
    startRunBudget(date, config.LLM_RUN_BUDGET_USD);
  }

  const db = getDb();
  const runDate = date;

  try {
    if (!opts.skipPortfolio) {
      recordPipelineStage({ runDate, stage: 'portfolio-sync', status: 'started' }, db);
      try {
        // Phase 4.5: portfolio sync + stop-loss are outside regime gates (`portfolio_exit_signals` /
        // `trailing_stop_update` are always-on at 100% in strategy-gates.json).
        await runPortfolioSync({ date });
        const stopLoss = detectStopLossBreaches({ date });
        log.info(
          { checked: stopLoss.checked, breached: stopLoss.breached },
          'stop-loss detector complete',
        );
        recordPipelineStage({ runDate, stage: 'portfolio-sync', status: 'success' }, db);
      } catch (err) {
        const msg = (err as Error).message;
        recordPipelineStage(
          { runDate, stage: 'portfolio-sync', status: 'failed', errorMsg: msg },
          db,
        );
        log.warn({ err: msg }, 'portfolio sync/stop-loss failed; continuing workflow');
        warnings.push({ category: 'Portfolio sync', message: msg });
      }
    }

    recordPipelineStage({ runDate, stage: 'ingest', status: 'started' }, db);
    let ingestResult: IngestRunResult;
    try {
      ingestResult = await runDailyIngestor({ date });
      recordPipelineStage(
        {
          runDate,
          stage: 'ingest',
          status: 'success',
          metadata: { symbolCount: ingestResult.symbols },
        },
        db,
      );
    } catch (err) {
      recordPipelineStage(
        { runDate, stage: 'ingest', status: 'failed', errorMsg: (err as Error).message },
        db,
      );
      throw err;
    }
    for (const f of ingestResult.failures) {
      warnings.push({
        category: 'Ingest',
        message: `${f.ingestor} could not fetch ${f.capability}: ${f.reason}`,
      });
    }

    recordPipelineStage({ runDate, stage: 'corporate-actions', status: 'started' }, db);
    try {
      await applyCorporateActionsFromYahooSplits(db, { refDate: date });
      recordPipelineStage({ runDate, stage: 'corporate-actions', status: 'success' }, db);
    } catch (err) {
      const msg = (err as Error).message;
      recordPipelineStage(
        { runDate, stage: 'corporate-actions', status: 'failed', errorMsg: msg },
        db,
      );
      log.warn({ err: msg }, 'corporate actions from Yahoo splits failed; continuing workflow');
      warnings.push({ category: 'Corporate actions', message: msg });
    }

    recordPipelineStage({ runDate, stage: 'enrich', status: 'started' }, db);
    try {
      await runSignalEnricher({ date });
      recordPipelineStage({ runDate, stage: 'enrich', status: 'success' }, db);
    } catch (err) {
      recordPipelineStage(
        { runDate, stage: 'enrich', status: 'failed', errorMsg: (err as Error).message },
        db,
      );
      throw err;
    }
    log.info('pipeline: enrich complete, starting yahoo snapshot ingest');

    recordPipelineStage({ runDate, stage: 'yahoo-snapshot', status: 'started' }, db);
    try {
      const snap = await ingestYahooSnapshots(db, { date });
      if (snap.failed > 0) {
        log.warn(snap, 'yahoo snapshot ingest partial failures');
      } else {
        log.info(snap, 'yahoo snapshot ingest complete');
      }
      recordPipelineStage({ runDate, stage: 'yahoo-snapshot', status: 'success' }, db);
    } catch (err) {
      recordPipelineStage(
        {
          runDate,
          stage: 'yahoo-snapshot',
          status: 'failed',
          errorMsg: (err as Error).message,
        },
        db,
      );
      log.warn(
        { err: (err as Error).message },
        'yahoo snapshot ingest failed unexpectedly; continuing workflow',
      );
    }

    recordPipelineStage({ runDate, stage: 'ext-signal', status: 'started' }, db);
    try {
      await runExtSignalHoldingsIngestor(db);
      recordPipelineStage({ runDate, stage: 'ext-signal', status: 'success' }, db);
    } catch (err) {
      const msg = (err as Error).message;
      recordPipelineStage({ runDate, stage: 'ext-signal', status: 'failed', errorMsg: msg }, db);
      warnings.push({
        category: 'External signals',
        message: `ext_signal_holdings ingest failed: ${msg}`,
      });
      log.warn({ err }, 'ext_signal: ingest failed — thesis corroboration unavailable');
    }

    recordPipelineStage({ runDate, stage: 'inav', status: 'started' }, db);
    try {
      const inav = await fetchInavSnapshots({ date, db });
      if (inav.failed) {
        log.warn({ date }, 'inav snapshot ingest skipped after NSE failure');
      }
      recordPipelineStage({ runDate, stage: 'inav', status: 'success' }, db);
    } catch (err) {
      const msg = (err as Error).message;
      recordPipelineStage({ runDate, stage: 'inav', status: 'failed', errorMsg: msg }, db);
      warnings.push({
        category: 'ETF iNAV',
        message: `iNAV fetch failed: ${msg}`,
      });
      log.warn({ err }, 'iNAV: fetch failed — ETF pricing card will not render');
    }

    log.info('pipeline: inav snapshots complete, starting regime classification');
    recordPipelineStage({ runDate, stage: 'regime', status: 'started' }, db);
    let regimeAgent: RunRegimeAgentResult;
    try {
      regimeAgent = await runRegimeAgent({ date, skipLlm: Boolean(opts.skipAi) });
      recordPipelineStage(
        {
          runDate,
          stage: 'regime',
          status: 'success',
          metadata: { regime: regimeAgent.regime },
        },
        db,
      );
    } catch (err) {
      recordPipelineStage(
        { runDate, stage: 'regime', status: 'failed', errorMsg: (err as Error).message },
        db,
      );
      throw err;
    }
    const momRegimeExits = applyMomentumRegimeGateExits({
      calendarDate: date,
      regime: regimeAgent.regime,
      db,
    });
    if (momRegimeExits > 0) {
      log.info({ momRegimeExits }, 'momentum regime gate: closed paper trades');
    }

    recordPipelineStage({ runDate, stage: 'screen', status: 'started' }, db);
    try {
      const screenResult = await runStockScreener({ date, regime: regimeAgent.regime });
      const matchCount = Object.values(screenResult.matchesByScreen).reduce((sum, n) => sum + n, 0);
      recordPipelineStage(
        { runDate, stage: 'screen', status: 'success', metadata: { matchCount } },
        db,
      );
    } catch (err) {
      recordPipelineStage(
        { runDate, stage: 'screen', status: 'failed', errorMsg: (err as Error).message },
        db,
      );
      throw err;
    }

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

      recordPipelineStage({ runDate, stage: 'thesis', status: 'started' }, db);
      try {
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
        recordPipelineStage(
          {
            runDate,
            stage: 'thesis',
            status: 'success',
            metadata: { generated: thesisResult.generated, failed: thesisResult.failed },
          },
          db,
        );
        log.info(
          { generated: thesisResult.generated, failed: thesisResult.failed },
          'thesis generation done',
        );
      } catch (err) {
        if (err instanceof LlmBudgetExceededError) {
          recordPipelineStage(
            { runDate, stage: 'thesis', status: 'skipped', errorMsg: err.message },
            db,
          );
          budgetExceeded = true;
          log.warn(
            { err, spent: err.spent, cap: err.cap },
            'thesis stage skipped: LLM budget exceeded',
          );
          warnings.push({
            category: 'LLM budget',
            message: `Thesis generation skipped — run LLM budget exceeded ($${err.spent.toFixed(4)} / $${err.cap.toFixed(2)}).`,
          });
        } else {
          recordPipelineStage(
            { runDate, stage: 'thesis', status: 'failed', errorMsg: (err as Error).message },
            db,
          );
          throw err;
        }
      }

      if (!opts.skipPortfolio) {
        recordPipelineStage({ runDate, stage: 'portfolio-analysis', status: 'started' }, db);
        try {
          const portfolioResult = await analysePortfolio({ date });
          if (portfolioResult.failed > 0) {
            warnings.push({
              category: 'Portfolio analysis',
              message: `${portfolioResult.failed} holding(s) failed AI analysis after retries; check LLM provider status. ${portfolioResult.analysed} holding(s) completed successfully.`,
            });
          }
          recordPipelineStage({ runDate, stage: 'portfolio-analysis', status: 'success' }, db);
          log.info(
            {
              analysed: portfolioResult.analysed,
              failed: portfolioResult.failed,
              byAction: portfolioResult.byAction,
            },
            'portfolio analysis done',
          );
        } catch (err) {
          if (err instanceof LlmBudgetExceededError) {
            recordPipelineStage(
              { runDate, stage: 'portfolio-analysis', status: 'skipped', errorMsg: err.message },
              db,
            );
            budgetExceeded = true;
            log.warn(
              { err, spent: err.spent, cap: err.cap },
              'portfolio-analysis stage skipped: LLM budget exceeded',
            );
            warnings.push({
              category: 'LLM budget',
              message: `Portfolio analysis skipped — run LLM budget exceeded ($${err.spent.toFixed(4)} / $${err.cap.toFixed(2)}).`,
            });
          } else {
            recordPipelineStage(
              {
                runDate,
                stage: 'portfolio-analysis',
                status: 'failed',
                errorMsg: (err as Error).message,
              },
              db,
            );
            throw err;
          }
        }
      }
    }

    recordPipelineStage({ runDate, stage: 'evaluate', status: 'started' }, db);
    let paperEval: EvaluateTradesResult;
    try {
      paperEval = runEvaluatePaperTrades(date, db, { skipAi: opts.skipAi });
      recordPipelineStage(
        {
          runDate,
          stage: 'evaluate',
          status: 'success',
          metadata: { evaluated: paperEval.evaluated, closed: paperEval.closed },
        },
        db,
      );
    } catch (err) {
      recordPipelineStage(
        { runDate, stage: 'evaluate', status: 'failed', errorMsg: (err as Error).message },
        db,
      );
      throw err;
    }
    log.info(paperEval, 'paper trade evaluation');

    let briefing: BriefRunResult;
    try {
      briefing = await runBriefingComposer({
        date,
        skipAi: opts.skipAi,
        thesisRun: opts.skipAi ? undefined : thesisRun,
        delivery: config.BRIEFING_DELIVERY,
        warnings: warnings.length > 0 ? warnings : undefined,
        budgetExceeded: budgetExceeded || undefined,
      });
    } catch (err) {
      recordPipelineStage(
        {
          runDate,
          stage: 'briefing',
          status: 'failed',
          errorMsg: (err as Error).message,
        },
        db,
      );
      throw err;
    }

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
  } finally {
    if (!opts.skipAi) {
      clearRunBudget(date);
    }
  }
}
