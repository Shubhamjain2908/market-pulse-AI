import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, migrate, upsertQuotes } from '../../src/db/index.js';
import {
  getOpenPaperTrades,
  getPaperTradeStats,
  insertPaperTradeIfAbsent,
  upsertSignals,
} from '../../src/db/queries.js';
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

  /** Deterministic atr_14 for adaptive trailing (`getAtr14` expects `signals.name = atr_14`). */
  function seedAtr14(symbol: string, dates: string[], value = 3): void {
    const sym = symbol.toUpperCase();
    upsertSignals(
      dates.map((dt) => ({
        symbol: sym,
        date: dt,
        name: 'atr_14',
        value,
        source: 'technical' as const,
      })),
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
    expect(evaluateOnePaperTrade(t, db, '2026-02-02', { skipAi: true })).toBe('CLOSED_WIN');
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
    expect(evaluateOnePaperTrade(t, db, '2026-02-02', { skipAi: true })).toBe('CLOSED_LOSS');
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
    expect(evaluateOnePaperTrade(t, db, '2026-02-02', { skipAi: true })).toBe('CLOSED_LOSS');
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
    expect(evaluateOnePaperTrade(t, db, '2026-03-04', { skipAi: true })).toBe('CLOSED_TIME');
    const row = db.prepare('SELECT status FROM paper_trades WHERE id = ?').get(t.id) as {
      status: string;
    };
    expect(row.status).toBe('CLOSED_TIME');
  });

  /**
   * Merge gate R5: after trailing catch-up fires a stop-out on bar 3, the evaluator must not
   * emit trailing_stop_log rows on subsequent bar dates for that trade (early return).
   */
  it('R5 — stop-out on bar 3 yields no trailing_stop_log on bars 4–5 dates', () => {
    const d1 = '2026-06-02';
    const d2 = '2026-06-03';
    const d3 = '2026-06-04';
    const d4 = '2026-06-05';
    const d5 = '2026-06-08';
    seedNifty(d1, d2, d3, d4, d5);
    upsertQuotes(
      [
        q('R5GATE', d1, 100, 108, 102, 105),
        q('R5GATE', d2, 106, 108, 103, 106),
        q('R5GATE', d3, 106, 110, 99, 107),
        q('R5GATE', d4, 108, 112, 105, 110),
        q('R5GATE', d5, 111, 115, 108, 113),
      ],
      db,
    );
    seedAtr14('R5GATE', ['2026-06-01', d1, d2, d3, d4, d5], 3);

    insertPaperTradeIfAbsent(
      {
        symbol: 'R5GATE',
        signalType: 'AI_PICK',
        sourceDate: '2026-06-01',
        entryPrice: 100,
        stopLoss: 90,
        target: 200,
        timeHorizon: 'medium',
        maxHoldDays: 90,
      },
      db,
    );
    const t = getOpenPaperTrades(db)[0];
    if (t === undefined) throw new Error('missing trade');

    expect(evaluateOnePaperTrade(t, db, d5, { skipAi: true })).toBe('CLOSED_WIN');

    const row = db
      .prepare('SELECT status, outcome_date, exit_reason FROM paper_trades WHERE id = ?')
      .get(t.id) as { status: string; outcome_date: string; exit_reason: string | null };
    expect(row.status).toBe('CLOSED_WIN');
    expect(row.outcome_date).toBe(d3);
    expect(row.exit_reason).toBe('TRAILING_STOP');

    const lateLogCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM trailing_stop_log
           WHERE trade_id = ? AND (log_date = ? OR log_date = ?)`,
        )
        .get(t.id, d4, d5) as { c: number }
    ).c;
    expect(lateLogCount).toBe(0);
  });

  /**
   * Merge gate R9: a profitable stopped-out exit tagged TRAILING_STOP must remain CLOSED_WIN
   * and count toward win stats (not flipped to CLOSED_LOSS by pnl heuristics).
   */
  it('R9 — profitable TRAILING_STOP exit stays CLOSED_WIN in stats', () => {
    const day1 = '2026-07-02';
    const day2 = '2026-07-03';
    const day3 = '2026-07-04';
    seedNifty(day1, day2, day3);
    upsertQuotes(
      [
        q('R9GATE', day1, 100, 109, 100, 105),
        q('R9GATE', day2, 106, 119, 111, 117),
        q('R9GATE', day3, 118, 118, 107, 115),
      ],
      db,
    );
    seedAtr14('R9GATE', ['2026-07-01', day1, day2, day3], 3);

    insertPaperTradeIfAbsent(
      {
        symbol: 'R9GATE',
        signalType: 'AI_PICK',
        sourceDate: '2026-07-01',
        entryPrice: 100,
        stopLoss: 92,
        target: 220,
        timeHorizon: 'medium',
        maxHoldDays: 90,
      },
      db,
    );
    const t = getOpenPaperTrades(db)[0];
    if (t === undefined) throw new Error('missing trade');

    expect(evaluateOnePaperTrade(t, db, day3, { skipAi: true })).toBe('CLOSED_WIN');

    const closed = db
      .prepare('SELECT status, pnl_pct, exit_reason FROM paper_trades WHERE id = ?')
      .get(t.id) as { status: string; pnl_pct: number; exit_reason: string | null };
    expect(closed.status).toBe('CLOSED_WIN');
    expect(closed.exit_reason).toBe('TRAILING_STOP');
    expect(closed.pnl_pct).toBeGreaterThan(0);

    const stats = getPaperTradeStats({ days: 30, asOf: day3 }, db);
    expect(stats.closedCount).toBe(1);
    expect(stats.winCount).toBe(1);
    expect(stats.lossCount).toBe(0);
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
    const r = runEvaluatePaperTrades('2026-02-02', db, { skipAi: true });
    expect(r.closed).toBe(1);
    expect(r.closedWin).toBe(1);
    expect(r.stillOpen).toBe(0);
  });
});
