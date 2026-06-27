/**
 * Schedule kite auto-login at 08:30 IST Mon–Fri (15 min before the 08:45 pipeline).
 * `pnpm kite-auto-login:schedule`
 */

import cron from 'node-cron';
import { closeDb } from '../../db/index.js';
import { runKiteAutoLogin } from './login.js';

const TZ = 'Asia/Kolkata';

function log(msg: string): void {
  const ts = new Intl.DateTimeFormat('en-IN', {
    timeZone: TZ,
    dateStyle: 'medium',
    timeStyle: 'medium',
    hour12: false,
  }).format(new Date());
  console.log(`[${ts} IST] ${msg}`);
}

cron.schedule(
  '30 8 * * 1-5',
  () => {
    void (async () => {
      log('kite auto-login started');
      try {
        const result = await runKiteAutoLogin();
        log(`kite auto-login success user=${result.userId}`);
      } catch (err) {
        log(`kite auto-login failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  },
  { timezone: TZ },
);

log('kite auto-login scheduler armed for 08:30 IST Mon–Fri (Ctrl+C to stop)');

process.on('SIGINT', () => {
  closeDb();
  process.exit(0);
});
process.on('SIGTERM', () => {
  closeDb();
  process.exit(0);
});
