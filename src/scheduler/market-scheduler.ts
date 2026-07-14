/**
 * Croner-based scheduler for recurring workflows.
 *
 * Required schedules (Asia/Kolkata):
 *  - Weekdays 08:45
 *  - Weekdays 16:30
 *  - Saturday 08:00
 *  - Sunday 06:00 — Yahoo momentum earnings calendar refresh (weekly)
 *  - Sunday 07:30 — weekly cleanup (briefings 90d, signals 730d)
 *  - Sunday 07:45 — COMEX gold COT ingest (CFTC disaggregated file)
 *  - Sunday 08:00 — momentum rank + rebalance (paper_trades), then skip-AI briefing with rebalance summary (delivered per BRIEFING_DELIVERY)
 */

import { Cron } from 'croner';
import { runBriefingComposer } from '../agents/briefing-composer.js';
import { type DailyWorkflowOptions, runDailyWorkflow } from '../agents/daily-workflow.js';
import { runWeeklyCleanup } from '../agents/weekly-cleanup.js';
import { deliverBriefing } from '../briefing/dispatch.js';
import { config } from '../config/env.js';
import { getMomentumUniverseSymbols } from '../config/loaders.js';
import { MARKET_TIMEZONE } from '../constants.js';
import { fetchGoldCot } from '../cot/fetch-gold-cot.js';
import { closeDb, getDb, migrate } from '../db/index.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { syncMomentumEarningsCalendarFromYahoo } from '../ingestors/yahoo/earnings-ingestor.js';
import { child } from '../logger.js';
import { getMarketClosure } from '../market/nse-calendar.js';
import {
  runMomentumRebalance,
  toMomentumRebalanceBriefingSummary,
} from '../strategies/momentum-rebalance.js';

const log = child({ component: 'market-scheduler' });

export interface SchedulerHandle {
  stop: () => void;
}

export function scheduledWorkflowOptions(tag: string): DailyWorkflowOptions {
  if (tag === 'weekday-1630') {
    return { skipAi: true, admitNewPaperTrades: false };
  }
  if (tag === 'weekday-0845' || tag === 'sat-0800') {
    return { admitNewPaperTrades: true };
  }
  // Defensive: unexpected tags behave like a non-admitting read-only run.
  return { skipAi: true, admitNewPaperTrades: false };
}

export function startScheduler(): SchedulerHandle {
  const weekdayMorning = new Cron(
    '45 8 * * 1-5',
    { timezone: MARKET_TIMEZONE, protect: true },
    () => runScheduledJob('weekday-0845'),
  );
  const weekdayClose = new Cron('30 16 * * 1-5', { timezone: MARKET_TIMEZONE, protect: true }, () =>
    runScheduledJob('weekday-1630'),
  );
  const saturdayMorning = new Cron('0 8 * * 6', { timezone: MARKET_TIMEZONE, protect: true }, () =>
    runScheduledJob('sat-0800'),
  );
  const sundayEarnings = new Cron(
    '0 6 * * 0',
    { timezone: MARKET_TIMEZONE, protect: true },
    () => void runSundayEarningsRefresh(),
  );
  const sundayWeeklyCleanup = new Cron(
    '30 7 * * 0',
    { timezone: MARKET_TIMEZONE, protect: true },
    () => void runSundayWeeklyCleanup(),
  );
  const sundayCotGold = new Cron(
    '45 7 * * 0',
    { timezone: MARKET_TIMEZONE, protect: true },
    () => void runSundayCotGoldFetch(),
  );
  const sundayMomentumRebalance = new Cron(
    '0 8 * * 0',
    { timezone: MARKET_TIMEZONE, protect: true },
    () => void runSundayMomentumRebalance(),
  );

  log.info(
    {
      timezone: MARKET_TIMEZONE,
      schedules: [
        '45 8 * * 1-5',
        '30 16 * * 1-5',
        '0 8 * * 6',
        '0 6 * * 0',
        '30 7 * * 0',
        '45 7 * * 0',
        '0 8 * * 0',
      ],
      delivery: config.BRIEFING_DELIVERY,
    },
    'scheduler started',
  );

  return {
    stop: () => {
      weekdayMorning.stop();
      weekdayClose.stop();
      saturdayMorning.stop();
      sundayEarnings.stop();
      sundayWeeklyCleanup.stop();
      sundayCotGold.stop();
      sundayMomentumRebalance.stop();
      log.info('scheduler stopped');
    },
  };
}

async function runSundayWeeklyCleanup(): Promise<void> {
  const t0 = Date.now();
  log.info({ tag: 'sun-0730', health: 'started' }, 'Sunday weekly cleanup started');
  try {
    migrate();
    await runWeeklyCleanup(getDb());
    log.info(
      { tag: 'sun-0730', health: 'ok', durationMs: Date.now() - t0 },
      'Sunday weekly cleanup finished',
    );
  } catch (err) {
    log.error(
      { tag: 'sun-0730', health: 'error', durationMs: Date.now() - t0, err },
      'Sunday weekly cleanup failed',
    );
  } finally {
    closeDb();
  }
}

async function runSundayMomentumRebalance(): Promise<void> {
  const t0 = Date.now();
  log.info({ tag: 'sun-0800', health: 'started' }, 'Sunday momentum rebalance started');
  try {
    migrate();
    const date = isoDateIst();
    const db = getDb();
    const result = await runMomentumRebalance({ calendarDate: date, db });
    const snap = result.rankerSnapshot;
    if (snap && snap.eligibleCount === 0 && snap.universeSize > 0) {
      log.warn(
        {
          tag: 'sun-0800',
          sessionDate: result.sessionDate,
          universeSize: snap.universeSize,
          eligibleCount: snap.eligibleCount,
        },
        'Sunday momentum: ranker produced zero eligible symbols — verify Friday Phase 3 enrich',
      );
    }
    log.info(
      { tag: 'sun-0800', health: 'ok', durationMs: Date.now() - t0, ...result },
      'Sunday momentum rebalance finished',
    );

    const summary = toMomentumRebalanceBriefingSummary(result);
    const closure = getMarketClosure(date);
    const briefing = await runBriefingComposer({
      date,
      skipAi: true,
      admitNewPaperTrades: false,
      marketClosure: closure ?? undefined,
      momentumRebalanceSummary: summary,
      delivery: config.BRIEFING_DELIVERY,
    });
    await deliverBriefing(briefing.html, briefing.date, config.BRIEFING_DELIVERY);
    log.info(
      { tag: 'sun-0800', briefingDate: briefing.date, summaryPresent: summary != null },
      'Sunday momentum briefing delivered',
    );
  } catch (err) {
    log.error(
      { tag: 'sun-0800', health: 'error', durationMs: Date.now() - t0, err },
      'Sunday momentum rebalance failed',
    );
  } finally {
    closeDb();
  }
}

async function runSundayCotGoldFetch(): Promise<void> {
  const t0 = Date.now();
  log.info({ tag: 'sun-0745', health: 'started' }, 'Sunday COMEX gold COT fetch started');
  try {
    migrate();
    const result = await fetchGoldCot(getDb());
    log.info(
      {
        tag: 'sun-0745',
        health: result.ok ? 'ok' : 'warn',
        durationMs: Date.now() - t0,
        inserted: result.inserted,
        reportDate: result.row?.reportDate,
        classification: result.row?.classification,
      },
      'Sunday COMEX gold COT fetch finished',
    );
  } catch (err) {
    log.error(
      { tag: 'sun-0745', health: 'error', durationMs: Date.now() - t0, err },
      'Sunday COMEX gold COT fetch failed',
    );
  } finally {
    closeDb();
  }
}

async function runSundayEarningsRefresh(): Promise<void> {
  const t0 = Date.now();
  log.info({ tag: 'sun-0600', health: 'started' }, 'Sunday earnings calendar refresh started');
  try {
    migrate();
    const date = isoDateIst();
    const symbols = getMomentumUniverseSymbols();
    const result = await syncMomentumEarningsCalendarFromYahoo(symbols, getDb(), { refDate: date });
    log.info(
      { tag: 'sun-0600', health: 'ok', durationMs: Date.now() - t0, ...result },
      'Sunday earnings calendar refresh finished',
    );
  } catch (err) {
    log.error(
      { tag: 'sun-0600', health: 'error', durationMs: Date.now() - t0, err },
      'Sunday earnings calendar refresh failed',
    );
  } finally {
    closeDb();
  }
}

async function runScheduledJob(tag: string): Promise<void> {
  const t0 = Date.now();
  log.info({ tag, health: 'started' }, 'scheduled job started');
  try {
    // EOD Reconciliation Run (16:30): skip AI, do not admit new paper trades.
    // Decision Run (08:45) and Saturday: full workflow, backward-compatible defaults.
    const result = await runDailyWorkflow(scheduledWorkflowOptions(tag));
    await deliverBriefing(result.html, result.date, config.BRIEFING_DELIVERY);
    log.info(
      {
        tag,
        health: 'ok',
        durationMs: Date.now() - t0,
        date: result.date,
        delivery: result.delivery,
        alerts: result.alertCount,
        screens: result.screenMatchesCount,
        news: result.newsCount,
        theses: result.thesesCount,
      },
      'scheduled job finished',
    );
  } catch (err) {
    log.error({ tag, health: 'error', durationMs: Date.now() - t0, err }, 'scheduled job failed');
  } finally {
    closeDb();
  }
}
