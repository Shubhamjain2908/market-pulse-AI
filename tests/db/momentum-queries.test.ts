import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, migrate } from '../../src/db/index.js';

const mockWarn = vi.hoisted(() => vi.fn());
const noop = vi.hoisted(() => vi.fn());

vi.mock('../../src/logger.js', () => {
  const stub = () => ({
    warn: mockWarn,
    info: noop,
    debug: noop,
    error: noop,
    child: stub,
  });
  const logger = stub();
  return { child: stub, logger };
});

import {
  hasMinPriceHistory,
  isInEarningsBlackoutCalendarWindow,
  replaceMomentumEarningsCalendarForSymbol,
} from '../../src/db/momentum-queries.js';

describe('db/momentum-queries', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-mom-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = dbPath;
    mockWarn.mockClear();
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

  it('replaceMomentumEarningsCalendarForSymbol retains rows on empty Yahoo response', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    db.prepare(
      `INSERT INTO earnings_calendar (symbol, expected_date, source, fetched_at)
       VALUES ('TEST', '2026-05-10', 'yahoo', '2026-05-07'),
              ('TEST', '2026-06-10', 'yahoo', '2026-05-07')`,
    ).run();

    replaceMomentumEarningsCalendarForSymbol(db, 'TEST', []);
    const afterEmpty = db
      .prepare(
        'SELECT expected_date FROM earnings_calendar WHERE symbol = ? ORDER BY expected_date',
      )
      .all('TEST') as { expected_date: string }[];
    expect(afterEmpty).toHaveLength(2);
    expect(afterEmpty.map((r) => r.expected_date)).toEqual(['2026-05-10', '2026-06-10']);
    expect(mockWarn).toHaveBeenCalledWith(
      { symbol: 'TEST' },
      'earnings_calendar: Yahoo returned 0 rows — retaining existing calendar, not clearing',
    );
    mockWarn.mockClear();

    replaceMomentumEarningsCalendarForSymbol(db, 'TEST', [
      { expectedDate: '2026-07-15', source: 'yahoo', fetchedAt: '2026-06-01T00:00:00.000Z' },
    ]);
    const afterReplace = db
      .prepare('SELECT expected_date, source, fetched_at FROM earnings_calendar WHERE symbol = ?')
      .all('TEST') as { expected_date: string; source: string; fetched_at: string }[];
    expect(afterReplace).toHaveLength(1);
    expect(afterReplace[0]).toEqual({
      expected_date: '2026-07-15',
      source: 'yahoo',
      fetched_at: '2026-06-01T00:00:00.000Z',
    });

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
