import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, migrate } from '../../src/db/index.js';
import {
  getPipelineHealth,
  getStageHistory,
  recordPipelineStage,
} from '../../src/db/pipeline-queries.js';

describe('db/pipeline-queries', () => {
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

  it('getStageHistory returns runs for the requested stage ordered by date desc', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    recordPipelineStage(
      {
        runDate: '2026-07-01',
        stage: 'yahoo-snapshot',
        status: 'success',
        metadata: { attempted: 250, written: 248, failed: 2 },
      },
      db,
    );
    recordPipelineStage(
      {
        runDate: '2026-07-02',
        stage: 'yahoo-snapshot',
        status: 'success',
        metadata: { attempted: 250, written: 250, failed: 0 },
      },
      db,
    );
    recordPipelineStage(
      {
        runDate: '2026-07-03',
        stage: 'enrich',
        status: 'failed',
        errorMsg: 'stale',
      },
      db,
    );

    const rows = getStageHistory('yahoo-snapshot', 7, db);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.runDate).toBe('2026-07-02');
    expect(rows[1]!.runDate).toBe('2026-07-01');
    expect(rows[0]!.status).toBe('success');
    expect(rows[1]!.status).toBe('success');

    // metadata is already parsed from JSON by getStageHistory
    expect(rows[0]!.metadata).toEqual({ attempted: 250, written: 250, failed: 0 });
  });

  it('getStageHistory respects the days parameter', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    recordPipelineStage(
      { runDate: '2026-06-01', stage: 'yahoo-snapshot', status: 'failed', errorMsg: 'timeout' },
      db,
    );
    recordPipelineStage({ runDate: '2026-07-01', stage: 'yahoo-snapshot', status: 'success' }, db);

    const oldRows = getStageHistory('yahoo-snapshot', 1, db);
    // 2026-06-01 is beyond 1 day, so only 2026-07-01 should appear
    expect(oldRows).toHaveLength(1);
    expect(oldRows[0]!.runDate).toBe('2026-07-01');
  });

  it('getStageHistory returns empty for a non-existent stage', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    recordPipelineStage({ runDate: '2026-07-01', stage: 'yahoo-snapshot', status: 'success' }, db);
    const rows = getStageHistory('enrich', 7, db);
    expect(rows).toEqual([]);
  });
});
