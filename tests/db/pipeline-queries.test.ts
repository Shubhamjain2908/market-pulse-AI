import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, migrate } from '../../src/db/index.js';
import { getPipelineHealth, recordPipelineStage } from '../../src/db/pipeline-queries.js';

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

  it('summarises degraded briefing health from latest required-stage statuses', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    const runDate = '2026-06-22';

    recordPipelineStage({ runDate, stage: 'thesis', status: 'failed', errorMsg: 'llm' }, db);
    expect(getPipelineHealth(runDate, db)).toEqual({
      degraded: false,
      failedRequiredStages: [],
      canShowRegimeCard: true,
    });

    recordPipelineStage({ runDate, stage: 'enrich', status: 'failed', errorMsg: 'stale' }, db);
    recordPipelineStage({ runDate, stage: 'regime', status: 'failed', errorMsg: 'stale' }, db);
    expect(getPipelineHealth(runDate, db)).toEqual({
      degraded: true,
      failedRequiredStages: ['enrich', 'regime'],
      canShowRegimeCard: false,
    });

    recordPipelineStage({ runDate, stage: 'regime', status: 'success' }, db);
    expect(getPipelineHealth(runDate, db)).toEqual({
      degraded: true,
      failedRequiredStages: ['enrich'],
      canShowRegimeCard: true,
    });

    recordPipelineStage({ runDate, stage: 'enrich', status: 'success' }, db);
    expect(getPipelineHealth(runDate, db)).toEqual({
      degraded: false,
      failedRequiredStages: [],
      canShowRegimeCard: true,
    });
  });
});
