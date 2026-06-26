import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runStage } from '../../src/agents/stage-runner.js';
import { migrate } from '../../src/db/migrate.js';

function readStages(db: Database.Database, runDate: string, stage: string) {
  return db
    .prepare(
      `SELECT status, error_msg AS errorMsg, metadata
       FROM pipeline_runs
       WHERE run_date = ? AND stage = ?
       ORDER BY id`,
    )
    .all(runDate, stage) as Array<{
    status: string;
    errorMsg: string | null;
    metadata: string | null;
  }>;
}

describe('runStage', () => {
  it('records started and success with metadata from the result', async () => {
    const db = new Database(':memory:');
    migrate(db);

    const result = await runStage({
      db,
      runDate: '2026-06-26',
      stage: 'ingest',
      policy: 'fatal',
      work: () => ({ symbols: 3 }),
      metadata: (value) => ({ symbolCount: value.symbols }),
    });

    expect(result).toEqual({ symbols: 3 });
    expect(readStages(db, '2026-06-26', 'ingest')).toEqual([
      { status: 'started', errorMsg: null, metadata: null },
      { status: 'success', errorMsg: null, metadata: '{"symbolCount":3}' },
    ]);
    db.close();
  });

  it('records failure and rethrows fatal stage errors', async () => {
    const db = new Database(':memory:');
    migrate(db);

    await expect(
      runStage({
        db,
        runDate: '2026-06-26',
        stage: 'enrich',
        policy: 'fatal',
        work: () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');

    expect(readStages(db, '2026-06-26', 'enrich')).toEqual([
      { status: 'started', errorMsg: null, metadata: null },
      { status: 'failed', errorMsg: 'boom', metadata: null },
    ]);
    db.close();
  });

  it('records failure and returns structured failure for warn stages', async () => {
    const db = new Database(':memory:');
    migrate(db);

    const result = await runStage({
      db,
      runDate: '2026-06-26',
      stage: 'inav',
      policy: 'warn',
      work: () => {
        throw new Error('nse down');
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('nse down');
    expect(readStages(db, '2026-06-26', 'inav')).toEqual([
      { status: 'started', errorMsg: null, metadata: null },
      { status: 'failed', errorMsg: 'nse down', metadata: null },
    ]);
    db.close();
  });

  it('records skipped without running work', async () => {
    const db = new Database(':memory:');
    migrate(db);

    const result = await runStage({
      db,
      runDate: '2026-06-26',
      stage: 'thesis',
      policy: 'skip',
      reason: 'budget exceeded',
    });

    expect(result).toEqual({ ok: false, skipped: true, reason: 'budget exceeded' });
    expect(readStages(db, '2026-06-26', 'thesis')).toEqual([
      { status: 'skipped', errorMsg: 'budget exceeded', metadata: null },
    ]);
    db.close();
  });
});
