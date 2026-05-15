import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildLiteSnapshotCopy,
  getLatestSignalsMap,
  getPortfolioDeepLossPct,
  needsPortfolioLlmReview,
  signalExtremesWarrantReview,
} from '../../src/agents/portfolio-trigger.js';
import { DbSignalProvider } from '../../src/analysers/signal-provider.js';
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
    const h = baseHolding('DEEP', getPortfolioDeepLossPct());
    upsertHoldings([h], db);
    expect(needsPortfolioLlmReview(h, date, db)).toBe(true);
  });

  it('respects PORTFOLIO_FULL_REVIEW_LOSS_PCT override', () => {
    process.env.PORTFOLIO_FULL_REVIEW_LOSS_PCT = '-20';
    const deep = baseHolding('EDGE', -21);
    const shallow = baseHolding('OK', -18);
    upsertHoldings([deep, shallow], db);
    expect(needsPortfolioLlmReview(deep, date, db)).toBe(true);
    expect(needsPortfolioLlmReview(shallow, date, db)).toBe(false);
    process.env.PORTFOLIO_FULL_REVIEW_LOSS_PCT = undefined;
  });

  it('lite snapshot produces deterministic bull and bear commentary', () => {
    upsertSignals(
      [
        { symbol: 'CALM', date, name: 'rsi_14', value: 34, source: 'technical' },
        {
          symbol: 'CALM',
          date,
          name: 'volume_ratio_20d',
          value: 1.25,
          source: 'technical',
        },
        {
          symbol: 'CALM',
          date,
          name: 'pct_from_52w_low',
          value: 4,
          source: 'technical',
        },
        {
          symbol: 'CALM',
          date,
          name: 'pct_from_52w_high',
          value: -25,
          source: 'technical',
        },
      ],
      db,
    );
    const h = baseHolding('CALM', -12);
    upsertHoldings([h], db);
    const copy = buildLiteSnapshotCopy(h, date, db);
    expect(copy.bullPoints.length).toBeGreaterThan(0);
    expect(copy.bearPoints.length).toBeGreaterThan(0);
    expect(copy.thesis).toContain('Technical snapshot');
    expect(copy.bullPoints.some((b) => /RSI|52W|Volume/i.test(b))).toBe(true);
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

  it('getLatestSignalsMap merges latest row per signal name across dates', () => {
    upsertSignals(
      [
        { symbol: 'MERGE', date: '2026-04-24', name: 'mom_rank', value: 17, source: 'momentum' },
        { symbol: 'MERGE', date, name: 'rsi_14', value: 44, source: 'technical' },
      ],
      db,
    );
    const m = getLatestSignalsMap('MERGE', date, db);
    expect(m.mom_rank).toBe(17);
    expect(m.rsi_14).toBe(44);
  });

  it('getLatestSignalsMap returns empty when only signals fall outside the 90-day window', () => {
    upsertSignals(
      [{ symbol: 'OLD', date: '2026-01-01', name: 'rsi_14', value: 99, source: 'technical' }],
      db,
    );
    const m = getLatestSignalsMap('OLD', date, db);
    expect(Object.keys(m)).toHaveLength(0);
  });

  it('DbSignalProvider technical lookup ignores signals older than 90 days', () => {
    upsertSignals(
      [{ symbol: 'OLD2', date: '2026-01-01', name: 'rsi_14', value: 88, source: 'technical' }],
      db,
    );
    const p = new DbSignalProvider(db);
    expect(p.get('OLD2', date, 'rsi_14')).toBeNull();
  });
});
