import type { Database as DatabaseType } from 'better-sqlite3';
import { getDb } from '../db/index.js';
import { recordPipelineStage } from '../db/pipeline-queries.js';

type StageMetadata<T> = object | ((result: T) => object | undefined);

interface BaseStageArgs {
  db?: DatabaseType;
  runDate: string;
  stage: string;
}

interface WorkStageArgs<T> extends BaseStageArgs {
  policy: 'fatal' | 'warn';
  work: () => T | Promise<T>;
  metadata?: StageMetadata<T>;
}

interface SkipStageArgs extends BaseStageArgs {
  policy: 'skip';
  reason: string;
  metadata?: object;
}

export type WarnStageResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: Error; message: string };

export type SkippedStageResult = { ok: false; skipped: true; reason: string };

export function runStage<T>(args: WorkStageArgs<T> & { policy: 'fatal' }): Promise<T>;
export function runStage<T>(
  args: WorkStageArgs<T> & { policy: 'warn' },
): Promise<WarnStageResult<T>>;
export function runStage(args: SkipStageArgs): Promise<SkippedStageResult>;
export async function runStage<T>(
  args: WorkStageArgs<T> | SkipStageArgs,
): Promise<T | WarnStageResult<T> | SkippedStageResult> {
  const db = args.db ?? getDb();

  if (args.policy === 'skip') {
    recordPipelineStage(
      {
        runDate: args.runDate,
        stage: args.stage,
        status: 'skipped',
        errorMsg: args.reason,
        metadata: args.metadata,
      },
      db,
    );
    return { ok: false, skipped: true, reason: args.reason };
  }

  recordPipelineStage({ runDate: args.runDate, stage: args.stage, status: 'started' }, db);

  try {
    const result = await args.work();
    recordPipelineStage(
      {
        runDate: args.runDate,
        stage: args.stage,
        status: 'success',
        metadata: typeof args.metadata === 'function' ? args.metadata(result) : args.metadata,
      },
      db,
    );
    if (args.policy === 'warn') return { ok: true, result };
    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    recordPipelineStage(
      { runDate: args.runDate, stage: args.stage, status: 'failed', errorMsg: error.message },
      db,
    );
    if (args.policy === 'warn') return { ok: false, error, message: error.message };
    throw error;
  }
}
