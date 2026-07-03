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
import { analyseConcallTranscripts } from './concall-analyser.js';
import { fetchConcallTranscripts } from '../ingestors/nse/announcements-fetcher.js';
import { fetchPromoterPledge } from '../ingestors/nse/pledge-fetcher.js';
import { syncMomentumEarningsCalendarFromYahoo } from '../ingestors/yahoo/earnings-ingestor.js';
import { ingestYahooSnapshots } from '../ingestors/yahoo-snapshot-ingestor.js';
import { clearRunBudget, LlmBudgetExceededError, startRunBudget } from '../llm/index.js';
import { child } from '../logger.js';
import { getMarketClosure, isSundayIst } from '../market/nse-calendar.js';
import { runMomentumRanker } from '../rankers/momentum-ranker.js';
import { type EvaluateTradesResult, runEvaluatePaperTrades } from '../scripts/evaluate-trades.js';
import { applyMomentumRegimeGateExits } from '../strategies/momentum-rebalance.js';
import { type BriefRunResult, runBriefingComposer } from './briefing-composer.js';
import { type IngestRunResult, runDailyIngestor } from './daily-ingestor.js';
import { analysePortfolio } from './portfolio-analyser.js';
import { runPortfolioSync } from './portfolio-sync.js';
import { type RunRegimeAgentResult, runRegimeAgent } from './regime-agent.js';
import { maybeWriteDailyRunSummary } from './run-summary.js';
import { runSignalEnricher } from './signal-enricher.js';
import { runStage } from './stage-runner.js';
import { runStockScreener } from './stock-screener.js';
import { detectStopLossBreaches } from './stop-loss-detector.js';
import { generateTheses } from './thesis-generator.js';

const log = child({ component: 'daily-workflow' });

/** Fail-open momentum rank refresh (writes `mom_rank` / `mom_false_flag` for thesis + gate). */
export function runMomentumRankStage(
  runDate: string,
  asOf: string,
  db: ReturnType<typeof getDb>,
): ReturnType<typeof runMomentumRanker> | null {
  recordPipelineStage({ runDate, stage: 'momentum-rank', status: 'started' }, db);
  try {
    const rankResult = runMomentumRanker({ asOf, db });
    recordPipelineStage(
      {
        runDate,
        stage: 'momentum-rank',
        status: 'success',
        metadata: {
          signalsWritten: rankResult.signalsWritten,
          eligibleCount: rankResult.eligibleCount,
        },
      },
      db,
    );
    return rankResult;
  } catch (err) {
    const msg = (err as Error).message;
    recordPipelineStage({ runDate, stage: 'momentum-rank', status: 'failed', errorMsg: msg }, db);
    log.warn({ err: msg }, 'momentum rank failed; continuing workflow');
    return null;
  }
}

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
  delivery: 'file' | 'email';
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
    const earningsStage = await runStage({
      db: sundayDb,
      runDate: date,
      stage: 'earnings-calendar',
      policy: 'warn',
      work: () =>
        syncMomentumEarningsCalendarFromYahoo(getMomentumUniverseSymbols(), sundayDb, {
          refDate: date,
        }),
    });
    if (!earningsStage.ok) {
      log.warn(
        { err: earningsStage.message },
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
      const portfolioSyncStage = await runStage({
        db,
        runDate,
        stage: 'portfolio-sync',
        policy: 'warn',
        work: async () => {
          // Phase 4.5: portfolio sync + stop-loss are outside regime gates (`portfolio_exit_signals` /
          // `trailing_stop_update` are always-on at 100% in strategy-gates.json).
          await runPortfolioSync({ date });
          const stopLoss = detectStopLossBreaches({ date });
          log.info(
            { checked: stopLoss.checked, breached: stopLoss.breached },
            'stop-loss detector complete',
          );
        },
      });
      if (!portfolioSyncStage.ok) {
        log.warn(
          { err: portfolioSyncStage.message },
          'portfolio sync/stop-loss failed; continuing workflow',
        );
        warnings.push({ category: 'Portfolio sync', message: portfolioSyncStage.message });
      }
    }

    const ingestResult: IngestRunResult = await runStage({
      db,
      runDate,
      stage: 'ingest',
      policy: 'fatal',
      work: () => runDailyIngestor({ date }),
      metadata: (result) => ({ symbolCount: result.symbols }),
    });
    for (const f of ingestResult.failures) {
      warnings.push({
        category: 'Ingest',
        message: `${f.ingestor} could not fetch ${f.capability}: ${f.reason}`,
      });
    }

    const corporateActionsStage = await runStage({
      db,
      runDate,
      stage: 'corporate-actions',
      policy: 'warn',
      work: () => applyCorporateActionsFromYahooSplits(db, { refDate: date }),
    });
    if (!corporateActionsStage.ok) {
      log.warn(
        { err: corporateActionsStage.message },
        'corporate actions from Yahoo splits failed; continuing workflow',
      );
      warnings.push({ category: 'Corporate actions', message: corporateActionsStage.message });
    }

    const pledgeStage = await runStage({
      db,
      runDate,
      stage: 'pledge',
      policy: 'warn',
      work: () => fetchPromoterPledge({ date, db }),
    });
    if (pledgeStage.ok) {
      const pledge = pledgeStage.result;
      if (pledge.failed) {
        log.warn({ date }, 'promoter pledge ingest skipped after NSE failure');
      }
    } else {
      warnings.push({
        category: 'Pledge',
        message: `Promoter pledge fetch failed: ${pledgeStage.message}`,
      });
      log.warn({ err: pledgeStage.error }, 'pledge: fetch failed — pledge gate will fail-open');
    }

    if (config.CONCALL_ANALYSIS_ENABLED === '1') {
      const concallFetchStage = await runStage({
        db,
        runDate,
        stage: 'concall-fetch',
        policy: 'warn',
        work: () => fetchConcallTranscripts({ date, db }),
      });
      if (concallFetchStage.ok) {
        const r = concallFetchStage.result;
        if (r.transcriptsFound > 0) {
          log.info({ transcriptsFound: r.transcriptsFound, extracted: r.extracted }, 'concall transcript ingest complete');
        }
      } else {
        warnings.push({
          category: 'Concall',
          message: `Concall transcript fetch failed: ${concallFetchStage.message}`,
        });
        log.warn({ err: concallFetchStage.error }, 'concall: fetch failed — transcripts unavailable');
      }
    }

    await runStage({
      db,
      runDate,
      stage: 'enrich',
      policy: 'fatal',
      work: () => runSignalEnricher({ date }),
    });
    log.info('pipeline: enrich complete, starting yahoo snapshot ingest');

    const yahooSnapshotStage = await runStage({
      db,
      runDate,
      stage: 'yahoo-snapshot',
      policy: 'warn',
      work: () => ingestYahooSnapshots(db, { date }),
      metadata: (result) => ({
        attempted: result.attempted,
        written: result.written,
        failed: result.failed,
      }),
    });
    if (yahooSnapshotStage.ok) {
      const snap = yahooSnapshotStage.result;
      if (snap.failed > 0) {
        log.warn(snap, 'yahoo snapshot ingest partial failures');
      } else {
        log.info(snap, 'yahoo snapshot ingest complete');
      }
    } else {
      log.warn(
        { err: yahooSnapshotStage.message },
        'yahoo snapshot ingest failed unexpectedly; continuing workflow',
      );
    }

    const rankResult = runMomentumRankStage(runDate, date, db);
    if (rankResult) {
      log.info(
        {
          signalsWritten: rankResult.signalsWritten,
          eligibleCount: rankResult.eligibleCount,
        },
        'momentum rank complete',
      );
    }

    const extSignalStage = await runStage({
      db,
      runDate,
      stage: 'ext-signal',
      policy: 'warn',
      work: () => runExtSignalHoldingsIngestor(db),
    });
    if (!extSignalStage.ok) {
      warnings.push({
        category: 'External signals',
        message: `ext_signal_holdings ingest failed: ${extSignalStage.message}`,
      });
      log.warn(
        { err: extSignalStage.error },
        'ext_signal: ingest failed — thesis corroboration unavailable',
      );
    }

    const inavStage = await runStage({
      db,
      runDate,
      stage: 'inav',
      policy: 'warn',
      work: () => fetchInavSnapshots({ date, db }),
    });
    if (inavStage.ok) {
      const inav = inavStage.result;
      if (inav.failed) {
        log.warn({ date }, 'inav snapshot ingest skipped after NSE failure');
      }
    } else {
      warnings.push({
        category: 'ETF iNAV',
        message: `iNAV fetch failed: ${inavStage.message}`,
      });
      log.warn({ err: inavStage.error }, 'iNAV: fetch failed — ETF pricing card will not render');
    }

    log.info('pipeline: inav snapshots complete, starting regime classification');
    const regimeAgent: RunRegimeAgentResult = await runStage({
      db,
      runDate,
      stage: 'regime',
      policy: 'fatal',
      work: () => runRegimeAgent({ date, skipLlm: Boolean(opts.skipAi) }),
      metadata: (result) => ({ regime: result.regime }),
    });
    const momRegimeExits = applyMomentumRegimeGateExits({
      calendarDate: date,
      regime: regimeAgent.regime,
      db,
    });
    if (momRegimeExits > 0) {
      log.info({ momRegimeExits }, 'momentum regime gate: closed paper trades');
    }

    await runStage({
      db,
      runDate,
      stage: 'screen',
      policy: 'fatal',
      work: () => runStockScreener({ date, regime: regimeAgent.regime }),
      metadata: (screenResult) => {
        const matchCount = Object.values(screenResult.matchesByScreen).reduce(
          (sum, n) => sum + n,
          0,
        );
        return { matchCount };
      },
    });

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

      if (!opts.skipAi && config.CONCALL_ANALYSIS_ENABLED === '1') {
        recordPipelineStage({ runDate, stage: 'concall-analysis', status: 'started' }, db);
        try {
          const concallResult = await analyseConcallTranscripts({}, db);
          recordPipelineStage(
            {
              runDate,
              stage: 'concall-analysis',
              status: 'success',
              metadata: { analysed: concallResult.analysed, failed: concallResult.failed },
            },
            db,
          );
          log.info(concallResult, 'concall analysis done');
        } catch (err) {
          if (err instanceof LlmBudgetExceededError) {
            recordPipelineStage(
              { runDate, stage: 'concall-analysis', status: 'skipped', errorMsg: err.message },
              db,
            );
            log.warn({ err, spent: err.spent, cap: err.cap }, 'concall analysis skipped: LLM budget exceeded');
          } else {
            recordPipelineStage(
              {
                runDate,
                stage: 'concall-analysis',
                status: 'failed',
                errorMsg: (err as Error).message,
              },
              db,
            );
            log.warn({ err: (err as Error).message }, 'concall analysis failed; continuing workflow');
          }
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

    const paperEval: EvaluateTradesResult = await runStage({
      db,
      runDate,
      stage: 'evaluate',
      policy: 'fatal',
      work: () => runEvaluatePaperTrades(date, db, { skipAi: opts.skipAi }),
      metadata: (result) => ({ evaluated: result.evaluated, closed: result.closed }),
    });
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
