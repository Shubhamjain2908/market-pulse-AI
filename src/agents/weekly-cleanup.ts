/**
 * Weekly housekeeping: retention deletes and future maintenance hooks.
 * Invoked from `market-scheduler` Sunday 07:30 IST slot only.
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { getDb } from '../db/index.js';
import { child } from '../logger.js';

const log = child({ component: 'weekly-cleanup' });

const BRIEFINGS_RETENTION_DAYS = 90;
const SIGNALS_RETENTION_DAYS = 730;

export async function runWeeklyCleanup(db: DatabaseType = getDb()): Promise<void> {
  const deletedBriefingRows = deleteBriefingsOlderThan90Days(db);
  const deletedSignalRows = deleteSignalsOlderThanRetention(db);

  log.info(
    { event: 'weekly_cleanup', deletedBriefingRows, deletedSignalRows },
    'weekly cleanup finished',
  );

  // ---------------------------------------------------------------------------
  // Future housekeeping (weekly slot)
  // ---------------------------------------------------------------------------
  // Add additional retention or maintenance steps below. Keep destructive SQL
  // isolated here and covered by logging; prefer transactions when multiple
  // tables are touched.
}

function deleteBriefingsOlderThan90Days(db: DatabaseType): number {
  const result = db
    .prepare(
      `DELETE FROM briefings
        WHERE created_at < datetime('now', '-' || ? || ' days')`,
    )
    .run(BRIEFINGS_RETENTION_DAYS);
  return result.changes;
}

function deleteSignalsOlderThanRetention(db: DatabaseType): number {
  const stmt = db.prepare(`
    DELETE FROM signals
    WHERE date < date('now', '-' || ? || ' days')
  `);
  const result = stmt.run(SIGNALS_RETENTION_DAYS);
  return result.changes;
}
