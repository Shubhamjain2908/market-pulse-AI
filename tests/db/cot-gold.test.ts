import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, migrate } from '../../src/db/index.js';
import { getLatestCotGold, insertCotGoldIgnore } from '../../src/db/queries.js';

describe('cot_gold queries', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-cot-gold-${Date.now()}-${Math.random()}.db`);
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

  it('insertCotGoldIgnore is idempotent on report_date', () => {
    const row = {
      reportDate: '2026-05-26',
      mmLong: 100,
      mmShort: 40,
      mmNet: 60,
      openInterest: 200,
      mmNetOiRatio: 0.3,
      ingestedAt: '2026-05-26T07:45:00.000Z',
    };
    expect(insertCotGoldIgnore(row, db)).toBe(true);
    expect(insertCotGoldIgnore(row, db)).toBe(false);
    expect(getLatestCotGold(db)?.reportDate).toBe('2026-05-26');
  });
});
