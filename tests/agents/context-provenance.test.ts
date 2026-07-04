import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildContextProvenance } from '../../src/agents/context-provenance.js';
import { migrate } from '../../src/db/migrate.js';
import {
  insertNews,
  upsertFundamentals,
  upsertQuotes,
  upsertSignals,
} from '../../src/db/queries.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

describe('buildContextProvenance', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('returns empty defaults when no data exists', () => {
    const refs = buildContextProvenance('RELIANCE', '2026-07-04', db);
    expect(refs.quotes.bars).toBe(0);
    expect(refs.fundamentals).toBeNull();
    expect(refs.quarterly).toBeNull();
    expect(refs.signals.count).toBe(0);
    expect(refs.news).toEqual([]);
    expect(refs.concall).toBeNull();
    expect(refs.pledge).toBeNull();
  });

  it('captures quote range', () => {
    upsertQuotes(
      [
        {
          symbol: 'RELIANCE',
          exchange: 'NSE',
          date: '2026-06-15',
          open: 100,
          high: 105,
          low: 99,
          close: 104,
          volume: 1000,
          source: 'nse',
        },
        {
          symbol: 'RELIANCE',
          exchange: 'NSE',
          date: '2026-06-16',
          open: 104,
          high: 108,
          low: 103,
          close: 107,
          volume: 1200,
          source: 'nse',
        },
        {
          symbol: 'RELIANCE',
          exchange: 'NSE',
          date: '2026-06-17',
          open: 107,
          high: 110,
          low: 106,
          close: 109,
          volume: 900,
          source: 'nse',
        },
      ],
      db,
    );
    const refs = buildContextProvenance('RELIANCE', '2026-06-17', db);
    expect(refs.quotes.bars).toBe(3);
    expect(refs.quotes.from).toBe('2026-06-15');
    expect(refs.quotes.to).toBe('2026-06-17');
    expect(refs.quotes.source).toBe('NSE');
  });

  it('captures fundamentals asOf', () => {
    upsertFundamentals(
      [{ symbol: 'RELIANCE', asOf: '2026-06-01', pe: 25, source: 'yahoo_snapshot' }],
      db,
    );
    const refs = buildContextProvenance('RELIANCE', '2026-07-04', db);
    expect(refs.fundamentals).not.toBeNull();
    expect(refs.fundamentals?.asOf).toBe('2026-06-01');
    expect(refs.fundamentals?.source).toBe('yahoo_snapshot');
  });

  it('captures signal count and latest date', () => {
    upsertSignals(
      [
        { symbol: 'RELIANCE', date: '2026-06-15', name: 'rsi_14', value: 65, source: 'technical' },
        { symbol: 'RELIANCE', date: '2026-06-16', name: 'sma_20', value: 102, source: 'technical' },
      ],
      db,
    );
    const refs = buildContextProvenance('RELIANCE', '2026-06-16', db);
    expect(refs.signals.count).toBe(2);
    expect(refs.signals.latestDate).toBe('2026-06-16');
  });

  it('captures news headlines', () => {
    insertNews(
      [
        {
          headline: 'RIL Q1 results beat estimates',
          source: 'Moneycontrol',
          url: 'https://example.com/ril',
          publishedAt: '2026-06-30T10:00:00Z',
        },
      ],
      db,
    );
    const refs = buildContextProvenance('RELIANCE', '2026-07-04', db);
    expect(refs.news.length).toBe(1);
    expect(refs.news[0]?.headline).toBe('RIL Q1 results beat estimates');
  });

  it('ignores news outside the 7-day window', () => {
    insertNews(
      [
        {
          headline: 'Old RIL news',
          source: 'Moneycontrol',
          url: 'https://example.com/old',
          publishedAt: '2026-06-01T10:00:00Z',
        },
      ],
      db,
    );
    const refs = buildContextProvenance('RELIANCE', '2026-07-04', db);
    expect(refs.news.length).toBe(0);
  });

  it('returns null concall and pledge when no data', () => {
    const refs = buildContextProvenance('RELIANCE', '2026-07-04', db);
    expect(refs.concall).toBeNull();
    expect(refs.pledge).toBeNull();
  });

  it('handles symbols that have no data at all', () => {
    const refs = buildContextProvenance('UNKNOWN', '2026-07-04', db);
    expect(refs.quotes.bars).toBe(0);
    expect(refs.signals.count).toBe(0);
    expect(refs.news).toEqual([]);
  });

  it('upper-cases symbol for DB lookups', () => {
    upsertQuotes(
      [
        {
          symbol: 'TCS',
          exchange: 'NSE',
          date: '2026-06-20',
          open: 100,
          high: 105,
          low: 99,
          close: 104,
          volume: 1000,
          source: 'nse',
        },
      ],
      db,
    );
    const refs = buildContextProvenance('tcs', '2026-06-20', db);
    expect(refs.quotes.bars).toBe(1);
  });
});
