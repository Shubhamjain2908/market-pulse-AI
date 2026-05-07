import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, migrate } from '../../src/db/index.js';
import {
  hasMinPriceHistory,
  isInEarningsBlackoutCalendarWindow,
} from '../../src/db/momentum-queries.js';

describe('db/momentum-queries', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-mom-${Date.now()}-${Math.random()}.db`);
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

  it('hasMinPriceHistory counts NSE rows on or before asOf', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    db.prepare(
      `INSERT INTO quotes (symbol, exchange, date, open, high, low, close, volume, source)
       VALUES ('TEST', 'NSE', '2026-01-02', 1,1,1,1, 100, 'test'),
              ('TEST', 'NSE', '2026-01-03', 1,1,1,1, 100, 'test')`,
    ).run();
    expect(hasMinPriceHistory('TEST', 2, '2026-01-03', db)).toBe(true);
    expect(hasMinPriceHistory('TEST', 3, '2026-01-03', db)).toBe(false);
    db.close();
  });

  it('isInEarningsBlackoutCalendarWindow matches ±3 calendar days (single SQL window)', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    db.prepare(
      `INSERT INTO earnings_calendar (symbol, expected_date, source, fetched_at)
       VALUES ('ABC', '2026-05-10', 'yahoo', '2026-05-07')`,
    ).run();
    expect(isInEarningsBlackoutCalendarWindow('ABC', '2026-05-07', db)).toBe(true);
    expect(isInEarningsBlackoutCalendarWindow('ABC', '2026-05-13', db)).toBe(true);
    expect(isInEarningsBlackoutCalendarWindow('ABC', '2026-05-14', db)).toBe(false);
    expect(isInEarningsBlackoutCalendarWindow('XYZ', '2026-05-10', db)).toBe(false);
    db.close();
  });

  it('isInEarningsBlackoutCalendarWindow respects custom windowDays', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    db.prepare(
      `INSERT INTO earnings_calendar (symbol, expected_date, source, fetched_at)
       VALUES ('ABC', '2026-05-10', 'yahoo', '2026-05-07')`,
    ).run();
    expect(isInEarningsBlackoutCalendarWindow('ABC', '2026-05-08', db, 2)).toBe(true);
    expect(isInEarningsBlackoutCalendarWindow('ABC', '2026-05-08', db, 1)).toBe(false);
    db.close();
  });
});
