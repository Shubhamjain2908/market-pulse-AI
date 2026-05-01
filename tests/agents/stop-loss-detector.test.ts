import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectStopLossBreaches } from '../../src/agents/stop-loss-detector.js';
import { getAlertsForDate } from '../../src/analysers/alerts.js';
import { closeDb, getDb, migrate, upsertHoldings, upsertQuotes } from '../../src/db/index.js';
import type { Portfolio, RawQuote } from '../../src/types/domain.js';

describe('stop-loss detector', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;
  const date = '2026-05-01';

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-stoploss-${Date.now()}-${Math.random()}.db`);
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

  it('creates stop_loss_breach alert when latest price is below configured stop', () => {
    upsertHoldings(
      [
        {
          symbol: 'INFY',
          exchange: 'NSE',
          asOf: date,
          qty: 10,
          avgPrice: 1500,
          lastPrice: 1420,
          source: 'kite',
        },
      ],
      db,
    );

    const portfolio: Portfolio = {
      currency: 'INR',
      totalCapital: 0,
      holdings: [{ symbol: 'INFY', qty: 10, avgPrice: 1500, stopLoss: 1450 }],
    };
    const result = detectStopLossBreaches({ date, portfolio }, db);

    expect(result.checked).toBe(1);
    expect(result.breached).toBe(1);
    expect(result.alerts[0]?.kind).toBe('stop_loss_breach');

    const persisted = getAlertsForDate(date, db);
    expect(persisted.some((a) => a.kind === 'stop_loss_breach' && a.symbol === 'INFY')).toBe(true);
  });

  it('falls back to EOD close when holding LTP is missing', () => {
    upsertHoldings(
      [
        {
          symbol: 'HDFCBANK',
          exchange: 'NSE',
          asOf: date,
          qty: 5,
          avgPrice: 1700,
          source: 'manual',
        },
      ],
      db,
    );
    const q: RawQuote = {
      symbol: 'HDFCBANK',
      exchange: 'NSE',
      date,
      open: 1600,
      high: 1610,
      low: 1580,
      close: 1590,
      adjClose: 1590,
      volume: 1_000_000,
      source: 'test',
    };
    upsertQuotes([q], db);

    const portfolio: Portfolio = {
      currency: 'INR',
      totalCapital: 0,
      holdings: [{ symbol: 'HDFCBANK', qty: 5, avgPrice: 1700, stopLoss: 1600 }],
    };
    const result = detectStopLossBreaches({ date, portfolio }, db);
    expect(result.breached).toBe(1);
  });
});
