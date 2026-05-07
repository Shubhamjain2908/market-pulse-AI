/**
 * Croner-based scheduler for recurring workflows.
 *
 * Required schedules (Asia/Kolkata):
 *  - Weekdays 07:30
 *  - Weekdays 15:30
 *  - Saturday 08:00
 *  - Sunday 06:00 — Yahoo momentum earnings calendar refresh (weekly)
 *  - Sunday 08:00 — momentum rank + rebalance (paper_trades)
 */

import { Cron } from 'croner';
import { runDailyWorkflow } from '../agents/daily-workflow.js';
import { config } from '../config/env.js';
import { getMomentumUniverseSymbols } from '../config/loaders.js';
import { MARKET_TIMEZONE } from '../constants.js';
import { closeDb, getDb, migrate } from '../db/index.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { syncMomentumEarningsCalendarFromYahoo } from '../ingestors/yahoo/earnings-ingestor.js';
import { child } from '../logger.js';
import { runMomentumRebalance } from '../strategies/momentum-rebalance.js';

const log = child({ component: 'market-scheduler' });

export interface SchedulerHandle {
  stop: () => void;
}

export function startScheduler(): SchedulerHandle {
  const weekdayMorning = new Cron(
    '30 7 * * 1-5',
    { timezone: MARKET_TIMEZONE, protect: true },
    () => runScheduledJob('weekday-0730'),
  );
  const weekdayClose = new Cron('30 15 * * 1-5', { timezone: MARKET_TIMEZONE, protect: true }, () =>
    runScheduledJob('weekday-1530'),
  );
  const saturdayMorning = new Cron('0 8 * * 6', { timezone: MARKET_TIMEZONE, protect: true }, () =>
    runScheduledJob('sat-0800'),
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
      schedules: ['30 7 * * 1-5', '30 15 * * 1-5', '0 8 * * 6', '0 6 * * 0', '0 8 * * 0'],
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
    const result = await runMomentumRebalance({ calendarDate: date, db: getDb() });
    log.info(
      { tag: 'sun-0800', health: 'ok', durationMs: Date.now() - t0, ...result },
      'Sunday momentum rebalance finished',
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

async function runScheduledJob(tag: string): Promise<void> {
  const t0 = Date.now();
  log.info({ tag, health: 'started' }, 'scheduled job started');
  try {
    const result = await runDailyWorkflow();
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
