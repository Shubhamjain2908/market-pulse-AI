import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRanker = vi.hoisted(() => vi.fn());

vi.mock('../../src/rankers/momentum-ranker.js', () => ({
  runMomentumRanker: mockRanker,
}));

vi.mock('../../src/logger.js', () => {
  const noop = vi.fn();
  const stub = () => ({ warn: noop, info: noop, error: noop, debug: noop, child: stub });
  return { child: stub, logger: stub() };
});

import { runMomentumRankStage } from '../../src/agents/daily-workflow.js';
import { closeDb, getDb, migrate } from '../../src/db/index.js';

describe('runMomentumRankStage', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-mom-stage-${Date.now()}.db`);
    process.env.DATABASE_PATH = dbPath;
    db = getDb({ path: dbPath });
    migrate(db);
    mockRanker.mockReset();
    mockRanker.mockReturnValue({
      asOf: '2026-06-22',
      universeSize: 10,
      eligibleCount: 8,
      signalsWritten: 24,
      rankClears: 0,
      ranked: [],
      excludedSymbols: [],
    });
  });

  afterEach(() => {
    db.close();
    closeDb();
    try {
      rmSync(dbPath);
    } catch {
      /* best effort */
    }
  });

  it('records success and passes explicit db to ranker', () => {
    const result = runMomentumRankStage('2026-06-22', '2026-06-22', db);
    expect(result?.signalsWritten).toBe(24);
    expect(mockRanker).toHaveBeenCalledWith({ asOf: '2026-06-22', db });
    const row = db
      .prepare(
        `SELECT status, metadata FROM pipeline_runs WHERE run_date = ? AND stage = 'momentum-rank' ORDER BY id DESC LIMIT 1`,
      )
      .get('2026-06-22') as { status: string; metadata: string };
    expect(row.status).toBe('success');
    expect(JSON.parse(row.metadata)).toMatchObject({ signalsWritten: 24, eligibleCount: 8 });
  });

  it('records failed on ranker throw and returns null', () => {
    mockRanker.mockImplementation(() => {
      throw new Error('rank boom');
    });
    const result = runMomentumRankStage('2026-06-22', '2026-06-22', db);
    expect(result).toBeNull();
    const row = db
      .prepare(
        `SELECT status, error_msg AS errorMsg FROM pipeline_runs WHERE run_date = ? AND stage = 'momentum-rank' ORDER BY id DESC LIMIT 1`,
      )
      .get('2026-06-22') as { status: string; errorMsg: string };
    expect(row.status).toBe('failed');
    expect(row.errorMsg).toBe('rank boom');
  });
});
