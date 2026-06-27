/**
 * Thin scheduler daemon for kite auto-login (08:30 IST Mon–Fri).
 *
 * ponytail: PM2 keeps this process alive 24/7 (~tens of MB idle). Playwright +
 * Chromium spin up only inside `runKiteAutoLogin()` at the cron trigger, then
 * close. For a zero-idle alternative, use system cron:
 *   30 8 * * 1-5 cd /opt/market-pulse-ai && pnpm kite-auto-login
 */

import { Cron } from 'croner';
import { MARKET_TIMEZONE } from '../../constants.js';
import { closeDb } from '../../db/index.js';
import { child } from '../../logger.js';
import { runKiteAutoLogin } from './login.js';

const log = child({ component: 'kite-auto-login-scheduler' });

export interface KiteAutoLoginSchedulerHandle {
  stop: () => void;
}

export function startKiteAutoLoginScheduler(): KiteAutoLoginSchedulerHandle {
  const job = new Cron(
    '30 8 * * 1-5',
    { timezone: MARKET_TIMEZONE, protect: true },
    () => void runScheduledKiteAutoLogin(),
  );

  log.info(
    { timezone: MARKET_TIMEZONE, schedule: '30 8 * * 1-5' },
    'kite auto-login scheduler armed',
  );

  return {
    stop: () => {
      job.stop();
      log.info('kite auto-login scheduler stopped');
    },
  };
}

async function runScheduledKiteAutoLogin(): Promise<void> {
  const t0 = Date.now();
  log.info({ tag: 'weekday-0830', health: 'started' }, 'kite auto-login started');
  try {
    const result = await runKiteAutoLogin();
    log.info(
      {
        tag: 'weekday-0830',
        health: 'ok',
        durationMs: Date.now() - t0,
        userId: result.userId,
      },
      'kite auto-login finished',
    );
  } catch (err) {
    log.error(
      { tag: 'weekday-0830', health: 'error', durationMs: Date.now() - t0, err },
      'kite auto-login failed',
    );
  } finally {
    closeDb();
  }
}

const isMain =
  process.argv[1]?.endsWith('index.ts') ||
  process.argv[1]?.endsWith('index.js') ||
  process.argv[1]?.includes('kite-auto-login/index');

if (isMain) {
  const handle = startKiteAutoLoginScheduler();
  const shutdown = (signal: 'SIGINT' | 'SIGTERM') => {
    log.info({ signal }, 'shutting down kite auto-login scheduler');
    handle.stop();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
