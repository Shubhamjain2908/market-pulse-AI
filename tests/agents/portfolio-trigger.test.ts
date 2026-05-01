import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PORTFOLIO_DEEP_LOSS_PCT,
  needsPortfolioLlmReview,
  signalExtremesWarrantReview,
} from '../../src/agents/portfolio-trigger.js';
import { closeDb, getDb, migrate, upsertHoldings, upsertSignals } from '../../src/db/index.js';
import type { PortfolioHoldingRow } from '../../src/db/portfolio-queries.js';

const date = '2026-04-30';

function baseHolding(symbol: string, pnlPct: number | null): PortfolioHoldingRow {
  return {
    symbol,
    exchange: 'NSE',
    asOf: date,
    qty: 10,
    avgPrice: 100,
    lastPrice: pnlPct != null ? 100 * (1 + pnlPct / 100) : 100,
    pnl: null,
    pnlPct,
    dayChange: 0,
    dayChangePct: 0,
    product: 'CNC',
    source: 'kite',
  };
}

describe('portfolio-trigger', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-pt-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = dbPath;
    db = getDb({ path: dbPath });
    migrate(db);
    process.env.PORTFOLIO_ANALYSIS_DISABLE_LITE = undefined;
  });

  afterEach(() => {
    db.close();
    closeDb();
    process.env.PORTFOLIO_ANALYSIS_DISABLE_LITE = undefined;
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(`${dbPath}${suffix}`);
      } catch {
        /* best effort */
      }
    }
  });

  it('forces full LLM at deep loss threshold', () => {
    const h = baseHolding('DEEP', PORTFOLIO_DEEP_LOSS_PCT);
    upsertHoldings([h], db);
    expect(needsPortfolioLlmReview(h, date, db)).toBe(true);
  });

  it('uses lite path when quiet and above deep-loss threshold', () => {
    process.env.PORTFOLIO_ANALYSIS_DISABLE_LITE = '0';
    const h = baseHolding('CALM', -5);
    upsertHoldings([h], db);
    expect(needsPortfolioLlmReview(h, date, db)).toBe(false);
  });

  it('forces full LLM when RSI is oversold (signal extreme)', () => {
    process.env.PORTFOLIO_ANALYSIS_DISABLE_LITE = '0';
    const h = baseHolding('RSI', -5);
    upsertHoldings([h], db);
    upsertSignals([{ symbol: 'RSI', date, name: 'rsi_14', value: 32, source: 'technical' }], db);
    expect(needsPortfolioLlmReview(h, date, db)).toBe(true);
  });

  it('forces full LLM when PORTFOLIO_ANALYSIS_DISABLE_LITE=1', () => {
    process.env.PORTFOLIO_ANALYSIS_DISABLE_LITE = '1';
    const h = baseHolding('FULL', -2);
    upsertHoldings([h], db);
    expect(needsPortfolioLlmReview(h, date, db)).toBe(true);
  });

  it('signalExtremesWarrantReview detects RSI stretch', () => {
    expect(signalExtremesWarrantReview({ rsi_14: 70 })).toBe(true);
    expect(signalExtremesWarrantReview({ rsi_14: 50 })).toBe(false);
  });
});
