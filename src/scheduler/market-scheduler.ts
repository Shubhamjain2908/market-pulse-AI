/**
 * Croner-based scheduler for recurring workflows.
 *
 * Required schedules (Asia/Kolkata):
 *  - Weekdays 08:45 — full daily pipeline + briefing delivery
 *  - Weekdays 16:30 — paper trade evaluation + EOD health report (email when BRIEFING_DELIVERY=email)
 *  - Friday 17:00 — weekly DB cleanup (signals retention; extend in weekly-cleanup agent)
 *  - Saturday 08:00
 *  - Sunday 06:00 — Yahoo momentum earnings calendar refresh (weekly)
 *  - Sunday 08:00 — momentum rank + rebalance (paper_trades), then skip-AI briefing with rebalance summary (delivered per BRIEFING_DELIVERY)
 */

import { Cron } from 'croner';
import { runBriefingComposer } from '../agents/briefing-composer.js';
import { runDailyWorkflow } from '../agents/daily-workflow.js';
import { runEodEvaluate } from '../agents/eod-evaluate.js';
import { runWeeklyCleanup } from '../agents/weekly-cleanup.js';
import { deliverBriefing } from '../briefing/dispatch.js';
import { config } from '../config/env.js';
import { getMomentumUniverseSymbols } from '../config/loaders.js';
import { MARKET_TIMEZONE } from '../constants.js';
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

/** Keys dispatched by `runScheduledJob` (string literals only; keep exhaustive). */
export type ScheduledCronJobKey =
  | 'weekday-0845'
  | 'weekday-1630-evaluate'
  | 'sat-0800'
  | 'friday-1700-cleanup';

export interface SchedulerHandle {
  stop: () => void;
}

export function startScheduler(): SchedulerHandle {
  const weekdayMorning = new Cron(
    '45 8 * * 1-5',
    { timezone: MARKET_TIMEZONE, protect: true },
    () => void runScheduledJob('weekday-0845'),
  );
  const weekdayEodEvaluate = new Cron(
    '30 16 * * 1-5',
    { timezone: MARKET_TIMEZONE, protect: true },
    () => void runScheduledJob('weekday-1630-evaluate'),
  );
  const fridayCleanup = new Cron(
    '0 17 * * 5',
    { timezone: MARKET_TIMEZONE, protect: true },
    () => void runScheduledJob('friday-1700-cleanup'),
  );
  const saturdayMorning = new Cron(
    '0 8 * * 6',
    { timezone: MARKET_TIMEZONE, protect: true },
    () => void runScheduledJob('sat-0800'),
  );
  const sundayEarnings = new Cron(
    '0 6 * * 0',
    { timezone: MARKET_TIMEZONE, protect: true },
    () => void runSundayEarningsRefresh(),
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
        '0 17 * * 5',
        '0 8 * * 6',
        '0 6 * * 0',
        '0 8 * * 0',
      ],
      delivery: config.BRIEFING_DELIVERY,
    },
    'scheduler started',
  );

  return {
    stop: () => {
      weekdayMorning.stop();
      weekdayEodEvaluate.stop();
      fridayCleanup.stop();
      saturdayMorning.stop();
      sundayEarnings.stop();
      sundayMomentumRebalance.stop();
      log.info('scheduler stopped');
    },
  };
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

async function runSundayEarningsRefresh(): Promise<void> {
  const t0 = Date.now();
  log.info({ tag: 'sun-0600', health: 'started' }, 'Sunday earnings calendar refresh started');
  try {
    migrate();
    const date = isoDateIst();
    const symbols = getMomentumUniverseSymbols({ fresh: true });
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

async function runScheduledJob(tag: ScheduledCronJobKey): Promise<void> {
  const t0 = Date.now();
  log.info({ tag, health: 'started' }, 'scheduled job started');
  try {
    migrate();
    switch (tag) {
      case 'weekday-0845':
      case 'sat-0800': {
        const result = await runDailyWorkflow();
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
        break;
      }
      case 'weekday-1630-evaluate': {
        await runEodEvaluate();
        log.info({ tag, health: 'ok', durationMs: Date.now() - t0 }, 'scheduled job finished');
        break;
      }
      case 'friday-1700-cleanup': {
        await runWeeklyCleanup();
        log.info({ tag, health: 'ok', durationMs: Date.now() - t0 }, 'scheduled job finished');
        break;
      }
      default: {
        const _exhaustive: never = tag;
        throw new Error(`unhandled scheduled job key: ${_exhaustive as string}`);
      }
    }
  } catch (err) {
    log.error({ tag, health: 'error', durationMs: Date.now() - t0, err }, 'scheduled job failed');
  } finally {
    closeDb();
  }
}
