/**
 * Friday-scheduled housekeeping: retention deletes and future maintenance hooks.
 * Invoked from `market-scheduler` job key `friday-1700-cleanup` only.
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { getDb } from '../db/index.js';
import { child } from '../logger.js';

const log = child({ component: 'weekly-cleanup' });

export async function runWeeklyCleanup(db: DatabaseType = getDb()): Promise<void> {
  const deletedSignalRows = deleteSignalsOlderThan365Days(db);

  log.info({ event: 'weekly_cleanup', deletedSignalRows }, 'weekly cleanup finished');

  // ---------------------------------------------------------------------------
  // Future housekeeping (Friday slot)
  // ---------------------------------------------------------------------------
  // Add additional retention or maintenance steps below. Keep destructive SQL
  // isolated here and covered by logging; prefer transactions when multiple
  // tables are touched.
}

function deleteSignalsOlderThan365Days(db: DatabaseType): number {
  const stmt = db.prepare(`
    DELETE FROM signals
    WHERE date < date('now', '-365 days')
  `);
  const result = stmt.run();
  return result.changes;
}
