/**
 * Pipeline stage audit trail (`pipeline_runs`). Wired from daily-workflow in a later PR.
 */

import type { Database as DatabaseType, Statement } from 'better-sqlite3';

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

const SELECT_FAILED_REQUIRED_STAGE_SQL = `
  SELECT 1 AS found FROM pipeline_runs
  WHERE run_date = ? AND status = 'failed'
    AND stage IN ('enrich', 'regime', 'screen')
  LIMIT 1
`;

type PipelineStmts = {
  insertPipelineStage: Statement;
  selectFailedRequiredStage: Statement;
};

const pipelineStmtsByDb = new WeakMap<DatabaseType, PipelineStmts>();

function pipelineStmts(db: DatabaseType): PipelineStmts {
  let stmts = pipelineStmtsByDb.get(db);
  if (!stmts) {
    stmts = {
      insertPipelineStage: db.prepare(INSERT_PIPELINE_STAGE_SQL),
      selectFailedRequiredStage: db.prepare(SELECT_FAILED_REQUIRED_STAGE_SQL),
    };
    pipelineStmtsByDb.set(db, stmts);
  }
  return stmts;
}

pipelineStmts(getDb());

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
  pipelineStmts(db).insertPipelineStage.run({
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

export function hasFailedRequiredStage(runDate: string, db: DatabaseType = getDb()): boolean {
  const row = pipelineStmts(db).selectFailedRequiredStage.get(runDate) as
    | { found: number }
    | undefined;
  return row !== undefined;
}
