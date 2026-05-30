import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, migrate } from '../../src/db/index.js';
import { getInavSnapshotsForDate, upsertInavSnapshots } from '../../src/db/queries.js';

describe('inav_snapshots queries', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-inav-${Date.now()}-${Math.random()}.db`);
    db = getDb({ path: dbPath });
    migrate(db);
  });

  afterEach(() => {
    db.close();
    closeDb();
    try {
      rmSync(dbPath);
      rmSync(`${dbPath}-wal`);
      rmSync(`${dbPath}-shm`);
    } catch {
      /* ignore */
    }
  });

  it('upserts and reads by date and symbol', () => {
    upsertInavSnapshots(
      [
        {
          symbol: 'NIFTYBEES',
          date: '2026-05-30',
          inav: 100,
          lastPrice: 100.75,
          premiumDiscountPct: 0.75,
          capturedAt: '2026-05-30T08:00:00.000Z',
        },
      ],
      db,
    );
    const rows = getInavSnapshotsForDate('2026-05-30', ['NIFTYBEES', 'RELIANCE'], db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.premiumDiscountPct).toBeCloseTo(0.75, 5);
  });
});
