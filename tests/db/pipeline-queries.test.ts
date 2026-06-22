import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, migrate } from '../../src/db/index.js';
import {
  hasFailedRequiredStage,
  listFailedRequiredStages,
  recordPipelineStage,
} from '../../src/db/pipeline-queries.js';

describe('db/pipeline-queries required-stage failure', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-pipeline-q-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = dbPath;
  });

  afterEach(() => {
    closeDb();
    try {
      rmSync(dbPath);
      rmSync(`${dbPath}-wal`);
      rmSync(`${dbPath}-shm`);
    } catch {
      // ignore
    }
  });

  it('uses latest status per stage so a successful retry clears degraded briefing', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    const runDate = '2026-06-22';

    recordPipelineStage({ runDate, stage: 'regime', status: 'failed', errorMsg: 'stale' }, db);
    expect(hasFailedRequiredStage(runDate, db)).toBe(true);
    expect(listFailedRequiredStages(runDate, db)).toEqual(['regime']);

    recordPipelineStage({ runDate, stage: 'regime', status: 'success' }, db);
    expect(hasFailedRequiredStage(runDate, db)).toBe(false);
    expect(listFailedRequiredStages(runDate, db)).toEqual([]);
  });
});
