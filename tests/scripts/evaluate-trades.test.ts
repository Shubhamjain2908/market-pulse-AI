import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, migrate, upsertQuotes } from '../../src/db/index.js';
import { getOpenPaperTrades, insertPaperTradeIfAbsent } from '../../src/db/queries.js';
import {
  evaluateOnePaperTrade,
  runEvaluatePaperTrades,
} from '../../src/scripts/evaluate-trades.js';
import type { RawQuote } from '../../src/types/domain.js';

function q(symbol: string, date: string, o: number, h: number, l: number, c: number): RawQuote {
  return {
    symbol,
    exchange: 'NSE',
    date,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 1,
    source: 't',
  };
}

describe('evaluate paper trades', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-ev-${Date.now()}.db`);
    process.env.DATABASE_PATH = dbPath;
    db = getDb({ path: dbPath });
    migrate(db);
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

  function seedNifty(...dates: string[]): void {
    upsertQuotes(
      dates.map((d) => q('NIFTY_50', d, 100, 101, 99, 100)),
      db,
    );
  }

  it('closes WIN when high reaches target', () => {
    seedNifty('2026-02-02');
    upsertQuotes([q('WINCO', '2026-02-02', 100, 130, 95, 125)], db);
    insertPaperTradeIfAbsent(
      {
        symbol: 'WINCO',
        signalType: 'AI_PICK',
        sourceDate: '2026-02-01',
        entryPrice: 100,
        stopLoss: 90,
        target: 120,
        timeHorizon: 'medium',
        maxHoldDays: 90,
      },
      db,
    );
    const open = getOpenPaperTrades(db);
    expect(open).toHaveLength(1);
    const t = open[0];
    if (t === undefined) throw new Error('missing trade');
    expect(evaluateOnePaperTrade(t, db, '2026-02-02')).toBe('CLOSED_WIN');
    const row = db.prepare('SELECT status, pnl_pct FROM paper_trades WHERE id = ?').get(t.id) as {
      status: string;
      pnl_pct: number;
    };
    expect(row.status).toBe('CLOSED_WIN');
    expect(row.pnl_pct).toBeCloseTo(20, 4);
  });

  it('closes LOSS when low hits stop', () => {
    seedNifty('2026-02-02');
    upsertQuotes([q('LOSECO', '2026-02-02', 100, 105, 85, 90)], db);
    insertPaperTradeIfAbsent(
      {
        symbol: 'LOSECO',
        signalType: 'AI_PICK',
        sourceDate: '2026-02-01',
        entryPrice: 100,
        stopLoss: 90,
        target: 120,
        timeHorizon: 'medium',
        maxHoldDays: 90,
      },
      db,
    );
    const open = getOpenPaperTrades(db);
    expect(open).toHaveLength(1);
    const t = open[0];
    if (t === undefined) throw new Error('missing trade');
    expect(evaluateOnePaperTrade(t, db, '2026-02-02')).toBe('CLOSED_LOSS');
  });

  it('same-day SL+TP counts as LOSS', () => {
    seedNifty('2026-02-02');
    upsertQuotes([q('BOTH', '2026-02-02', 100, 125, 85, 100)], db);
    insertPaperTradeIfAbsent(
      {
        symbol: 'BOTH',
        signalType: 'AI_PICK',
        sourceDate: '2026-02-01',
        entryPrice: 100,
        stopLoss: 90,
        target: 120,
        timeHorizon: 'medium',
        maxHoldDays: 90,
      },
      db,
    );
    const open = getOpenPaperTrades(db);
    expect(open).toHaveLength(1);
    const t = open[0];
    if (t === undefined) throw new Error('missing trade');
    expect(evaluateOnePaperTrade(t, db, '2026-02-02')).toBe('CLOSED_LOSS');
  });

  it('time-stops after max_hold_days on Nifty calendar', () => {
    seedNifty('2026-03-02', '2026-03-03', '2026-03-04');
    upsertQuotes(
      [q('TIMEY', '2026-03-02', 100, 105, 98, 102), q('TIMEY', '2026-03-03', 102, 108, 101, 106)],
      db,
    );
    insertPaperTradeIfAbsent(
      {
        symbol: 'TIMEY',
        signalType: 'AI_PICK',
        sourceDate: '2026-03-01',
        entryPrice: 100,
        stopLoss: 80,
        target: 200,
        timeHorizon: 'short',
        maxHoldDays: 2,
      },
      db,
    );
    const open = getOpenPaperTrades(db);
    expect(open).toHaveLength(1);
    const t = open[0];
    if (t === undefined) throw new Error('missing trade');
    expect(evaluateOnePaperTrade(t, db, '2026-03-04')).toBe('CLOSED_TIME');
    const row = db.prepare('SELECT status FROM paper_trades WHERE id = ?').get(t.id) as {
      status: string;
    };
    expect(row.status).toBe('CLOSED_TIME');
  });

  it('runEvaluatePaperTrades returns counts', () => {
    seedNifty('2026-02-02');
    upsertQuotes([q('R1', '2026-02-02', 100, 130, 95, 125)], db);
    insertPaperTradeIfAbsent(
      {
        symbol: 'R1',
        signalType: 'AI_PICK',
        sourceDate: '2026-02-01',
        entryPrice: 100,
        stopLoss: 90,
        target: 120,
        timeHorizon: 'medium',
        maxHoldDays: 90,
      },
      db,
    );
    const r = runEvaluatePaperTrades('2026-02-02', db);
    expect(r.closed).toBe(1);
    expect(r.closedWin).toBe(1);
    expect(r.stillOpen).toBe(0);
  });
});
