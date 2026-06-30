/**
 * Pipeline stage audit trail (`pipeline_runs`). Wired from daily-workflow in a later PR.
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { child } from '../logger.js';
import { getDb } from './connection.js';

const log = child({ component: 'pipeline-queries' });

export type PipelineStatus = 'started' | 'success' | 'failed' | 'skipped';

const INSERT_PIPELINE_STAGE_SQL = `
  INSERT INTO pipeline_runs (run_date, stage, status, finished_at, error_msg, metadata)
  VALUES (
    @runDate,
    @stage,
    @status,
    CASE
      WHEN @status IN ('success', 'failed', 'skipped') THEN datetime('now')
      ELSE NULL
    END,
    @errorMsg,
    @metadata
  )
`;

const STAGE_HISTORY_SQL = `
  SELECT run_date AS runDate, stage, status, finished_at AS finishedAt,
         error_msg AS errorMsg, metadata
  FROM pipeline_runs
  WHERE stage = ?
    AND run_date >= date('now', '-' || ? || ' days')
  ORDER BY run_date DESC, id DESC
`;

/** Latest row per required stage — retries must not leave stale failures. */
const LATEST_REQUIRED_STAGE_STATUS_SQL = `
  SELECT stage, status FROM (
    SELECT stage, status,
      ROW_NUMBER() OVER (PARTITION BY stage ORDER BY id DESC) AS rn
    FROM pipeline_runs
    WHERE run_date = ? AND stage IN ('enrich', 'regime', 'screen')
  )
  WHERE rn = 1
`;

export interface PipelineHealth {
  degraded: boolean;
  failedRequiredStages: string[];
  canShowRegimeCard: boolean;
}

export function recordPipelineStage(
  args: {
    runDate: string;
    stage: string;
    status: PipelineStatus;
    errorMsg?: string;
    metadata?: object;
  },
  db: DatabaseType = getDb(),
): void {
  db.prepare(INSERT_PIPELINE_STAGE_SQL).run({
    runDate: args.runDate,
    stage: args.stage,
    status: args.status,
    errorMsg: args.errorMsg ?? null,
    metadata: args.metadata !== undefined ? JSON.stringify(args.metadata) : null,
  });

  if (args.status === 'failed') {
    log.warn(
      { runDate: args.runDate, stage: args.stage, errorMsg: args.errorMsg },
      'pipeline stage failed',
    );
  } else {
    log.debug(
      { runDate: args.runDate, stage: args.stage, status: args.status },
      'pipeline stage recorded',
    );
  }
}

export interface StageRun {
  runDate: string;
  stage: string;
  status: PipelineStatus;
  finishedAt: string | null;
  errorMsg: string | null;
  metadata: string | null;
}

export function getStageHistory(
  stage: string,
  days: number = 7,
  db: DatabaseType = getDb(),
): StageRun[] {
  return db.prepare(STAGE_HISTORY_SQL).all(stage, days) as StageRun[];
}

export function getPipelineHealth(runDate: string, db: DatabaseType = getDb()): PipelineHealth {
  const rows = db.prepare(LATEST_REQUIRED_STAGE_STATUS_SQL).all(runDate) as Array<{
    stage: string;
    status: PipelineStatus;
  }>;
  const latest = new Map(rows.map((row) => [row.stage, row.status]));
  const failedRequiredStages = rows
    .filter((row) => row.status === 'failed')
    .map((row) => row.stage)
    .sort();
  const degraded = failedRequiredStages.length > 0;

  return {
    degraded,
    failedRequiredStages,
    canShowRegimeCard: !degraded || latest.get('regime') === 'success',
  };
}
