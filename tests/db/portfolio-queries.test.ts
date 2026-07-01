import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeDb,
  getDb,
  migrate,
  resolveBookValueInr,
  sumHoldingsBookValueInr,
  upsertHoldings,
} from '../../src/db/index.js';

describe('portfolio-queries book value', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-pq-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = dbPath;
    db = getDb({ path: dbPath });
    migrate(db);
  });

  afterEach(() => {
    db.close();
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(`${dbPath}${suffix}`);
      } catch {
        // best effort
      }
    }
  });

  it('sums kite holdings mark-to-market (lastPrice preferred)', () => {
    upsertHoldings(
      [
        {
          symbol: 'RELIANCE',
          exchange: 'NSE',
          asOf: '2026-06-02',
          qty: 10,
          avgPrice: 2500,
          lastPrice: 2600,
          source: 'kite',
        },
        {
          symbol: 'TCS',
          exchange: 'NSE',
          asOf: '2026-06-02',
          qty: 5,
          avgPrice: 4000,
          lastPrice: null,
          source: 'kite',
        },
      ],
      db,
    );

    const book = resolveBookValueInr(db);
    expect(book.source).toBe('holdings');
    expect(book.holdingsAsOf).toBe('2026-06-02');
    expect(book.holdingCount).toBe(2);
    expect(book.bookValueInr).toBe(10 * 2600 + 5 * 4000);
    expect(sumHoldingsBookValueInr([])).toBe(0);
  });

  it('ignores zero-qty rows in the book sum', () => {
    upsertHoldings(
      [
        {
          symbol: 'INFY',
          exchange: 'NSE',
          asOf: '2026-06-03',
          qty: 0,
          avgPrice: 1500,
          lastPrice: 1600,
          source: 'kite',
        },
        {
          symbol: 'HDFCBANK',
          exchange: 'NSE',
          asOf: '2026-06-03',
          qty: 2,
          avgPrice: 1000,
          lastPrice: 1100,
          source: 'kite',
        },
      ],
      db,
    );

    expect(resolveBookValueInr(db).bookValueInr).toBe(2200);
  });
});
