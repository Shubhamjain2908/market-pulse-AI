/**
 * Croner-based scheduler for recurring workflows.
 *
 * Required schedules (Asia/Kolkata):
 *  - Weekdays 07:30
 *  - Weekdays 15:30
 *  - Saturday 08:00
 */

import { Cron } from 'croner';
import { runDailyWorkflow } from '../agents/daily-workflow.js';
import { config } from '../config/env.js';
import { MARKET_TIMEZONE } from '../constants.js';
import { closeDb } from '../db/index.js';
import { child } from '../logger.js';

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

  log.info(
    {
      timezone: MARKET_TIMEZONE,
      schedules: ['30 7 * * 1-5', '30 15 * * 1-5', '0 8 * * 6'],
      delivery: config.BRIEFING_DELIVERY,
    },
    'scheduler started',
  );

  return {
    stop: () => {
      weekdayMorning.stop();
      weekdayClose.stop();
      saturdayMorning.stop();
      log.info('scheduler stopped');
    },
  };
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
