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
  exitPriceWhenStopHit,
  runEvaluatePaperTrades,
} from '../../src/scripts/evaluate-trades.js';
import type { RawQuote } from '../../src/types/domain.js';
import { GAP_DOWN_THROUGH_STOP_NOTE } from '../../src/types/trailing-stop.js';

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

describe('exitPriceWhenStopHit (R3)', () => {
  it('fills at open when session gaps below the stop', () => {
    const bar = { date: '2026-01-02', open: 95, high: 100, low: 96, close: 99 };
    expect(exitPriceWhenStopHit(bar, 99)).toBe(95);
  });

  it('fills at stop when open is at or above the stop', () => {
    const bar = { date: '2026-01-02', open: 100, high: 105, low: 92, close: 98 };
    expect(exitPriceWhenStopHit(bar, 95)).toBe(95);
  });
});

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
    const row = db
      .prepare('SELECT status, pnl_pct, exit_reason FROM paper_trades WHERE id = ?')
      .get(t.id) as {
      status: string;
      pnl_pct: number;
      exit_reason: string | null;
    };
    expect(row.status).toBe('CLOSED_WIN');
    expect(row.pnl_pct).toBeCloseTo(20, 4);
    expect(row.exit_reason).toBe('TARGET_HIT');
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
    upsertQuotes([q('BOTH', '2026-02-02', 100, 130, 85, 125)], db);
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
    const row = db
      .prepare('SELECT exit_reason, notes FROM paper_trades WHERE id = ?')
      .get(t.id) as { exit_reason: string | null; notes: string | null };
    expect(row.exit_reason).toBe('INITIAL_STOP');
    expect(row.notes ?? '').toContain('same-day SL+TP');
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

  describe('§9.2 evaluator integration (spec)', () => {
    it('9.2.1 — R3 gap-down open: exit at bar.open, STOPPED_OUT log notes, reconciled prices', () => {
      const src = '2026-09-01';
      const d1 = '2026-09-02';
      const d2 = '2026-09-03';
      seedNifty(d1, d2);
      upsertQuotes([q('GAP92', d1, 100, 112, 100, 108), q('GAP92', d2, 98, 105, 101, 104)], db);
      seedAtr14('GAP92', [src, d1, d2], 3);
      insertPaperTradeIfAbsent(
        {
          symbol: 'GAP92',
          signalType: 'AI_PICK',
          sourceDate: src,
          entryPrice: 100,
          stopLoss: 90,
          target: 220,
          timeHorizon: 'medium',
          maxHoldDays: 90,
        },
        db,
      );
      const t = getOpenPaperTrades(db)[0];
      if (t === undefined) throw new Error('missing trade');
      expect(evaluateOnePaperTrade(t, db, d2, { skipAi: true })).toBe('CLOSED_LOSS');

      const closed = db
        .prepare('SELECT status, exit_price, pnl_pct FROM paper_trades WHERE id = ?')
        .get(t.id) as { status: string; exit_price: number; pnl_pct: number };
      expect(closed.status).toBe('CLOSED_LOSS');
      expect(closed.exit_price).toBe(98);
      expect(closed.pnl_pct).toBeCloseTo(-2, 4);

      const logRow = db
        .prepare(
          `SELECT notes, new_stop FROM trailing_stop_log WHERE trade_id = ? AND action = 'STOPPED_OUT'`,
        )
        .get(t.id) as { notes: string | null; new_stop: number };
      expect(logRow?.notes).toBe(GAP_DOWN_THROUGH_STOP_NOTE);
      expect(logRow?.new_stop).toBe(98);
    });

    it('9.2.2 — first session bar stop-out uses INITIAL_STOP (Day-1 block)', () => {
      const src = '2026-08-01';
      const d1 = '2026-08-02';
      seedNifty(d1);
      upsertQuotes([q('INIT1', d1, 95, 100, 88, 92)], db);
      seedAtr14('INIT1', [src], 5);
      insertPaperTradeIfAbsent(
        {
          symbol: 'INIT1',
          signalType: 'AI_PICK',
          sourceDate: src,
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
      expect(evaluateOnePaperTrade(t, db, d1, { skipAi: true })).toBe('CLOSED_LOSS');
      const row = db.prepare('SELECT exit_reason FROM paper_trades WHERE id = ?').get(t.id) as {
        exit_reason: string | null;
      };
      expect(row.exit_reason).toBe('INITIAL_STOP');
    });

    it('9.2.3 — momentum hard_stop_pct floor raises loose LLM stop (no atr on source)', () => {
      const src = '2026-10-01';
      const d1 = '2026-10-02';
      seedNifty(d1);
      upsertQuotes([q('HFLOOR', d1, 100, 105, 93, 102)], db);
      insertPaperTradeIfAbsent(
        {
          symbol: 'HFLOOR',
          signalType: 'AI_PICK',
          sourceDate: src,
          entryPrice: 100,
          stopLoss: 85,
          target: 200,
          timeHorizon: 'medium',
          maxHoldDays: 90,
        },
        db,
      );
      const t = getOpenPaperTrades(db)[0];
      if (t === undefined) throw new Error('missing trade');
      expect(evaluateOnePaperTrade(t, db, d1, { skipAi: true })).toBe('still_open');
      const still = getOpenPaperTrades(db)[0];
      expect(still?.stopLoss).toBe(92);
    });

    it('9.2.4 — hard floor applies when trade already initialized and atr_14 missing today', () => {
      const src = '2026-11-01';
      const d1 = '2026-11-02';
      seedNifty(d1);
      upsertQuotes([q('INITFLOOR', d1, 100, 105, 91, 102)], db);
      insertPaperTradeIfAbsent(
        {
          symbol: 'INITFLOOR',
          signalType: 'AI_PICK',
          sourceDate: src,
          entryPrice: 100,
          stopLoss: 85,
          target: 200,
          timeHorizon: 'medium',
          maxHoldDays: 90,
        },
        db,
      );
      const rowId = (
        db.prepare('SELECT id FROM paper_trades WHERE symbol = ?').get('INITFLOOR') as {
          id: number;
        }
      ).id;
      db.prepare(
        `
        UPDATE paper_trades
        SET highest_close_since_entry = ?, atr14_at_entry = ?
        WHERE id = ?
      `,
      ).run(105, 3, rowId);

      const t = getOpenPaperTrades(db)[0];
      if (t === undefined) throw new Error('missing trade');
      expect(evaluateOnePaperTrade(t, db, d1, { skipAi: true })).toBe('CLOSED_LOSS');

      const closed = db
        .prepare('SELECT exit_price, pnl_pct, exit_reason FROM paper_trades WHERE id = ?')
        .get(rowId) as { exit_price: number; pnl_pct: number; exit_reason: string | null };
      expect(closed.exit_price).toBe(92);
      expect(closed.pnl_pct).toBeCloseTo(-8, 4);
      expect(closed.exit_reason).toBe('TRAILING_STOP');
    });
  });

  it('circuit breaker: >30% gap down skips stop-out; trade stays OPEN', () => {
    const src = '2026-03-01';
    const dPrev = '2026-03-02';
    const dGap = '2026-03-03';
    seedNifty(dPrev, dGap);
    upsertQuotes(
      [{ ...q('CBRK', dPrev, 100, 100, 100, 100) }, { ...q('CBRK', dGap, 60, 100, 75, 80) }],
      db,
    );
    insertPaperTradeIfAbsent(
      {
        symbol: 'CBRK',
        signalType: 'AI_PICK',
        sourceDate: src,
        entryPrice: 100,
        stopLoss: 85,
        target: 200,
        timeHorizon: 'medium',
        maxHoldDays: 90,
      },
      db,
    );
    const rowId = (
      db.prepare('SELECT id FROM paper_trades WHERE symbol = ?').get('CBRK') as {
        id: number;
      }
    ).id;
    db.prepare(
      'UPDATE paper_trades SET highest_close_since_entry = 100, atr14_at_entry = 3 WHERE id = ?',
    ).run(rowId);
    seedAtr14('CBRK', [src, dPrev, dGap], 3);
    const t = getOpenPaperTrades(db)[0];
    if (t === undefined) throw new Error('missing trade');
    expect(evaluateOnePaperTrade(t, db, dGap, { skipAi: true })).toBe('still_open');
    expect(getOpenPaperTrades(db)).toHaveLength(1);
  });

  it('incremental resume: inflated persisted stop does not replay prior bars (no false stop-out)', () => {
    const src = '2026-04-01';
    const d1 = '2026-04-02';
    const d2 = '2026-04-03';
    seedNifty(d1, d2);
    upsertQuotes(
      [
        q('RESUME1', d1, 100, 105, 95, 100),
        q('RESUME1', d2, 100, 105, 99, 100),
      ],
      db,
    );
    seedAtr14('RESUME1', [src, d1, d2], 3);

    insertPaperTradeIfAbsent(
      {
        symbol: 'RESUME1',
        signalType: 'AI_PICK',
        sourceDate: src,
        entryPrice: 100,
        stopLoss: 85,
        target: 220,
        timeHorizon: 'medium',
        maxHoldDays: 90,
      },
      db,
    );
    const rowId = (
      db.prepare('SELECT id FROM paper_trades WHERE symbol = ?').get('RESUME1') as { id: number }
    ).id;
    db.prepare(
      'UPDATE paper_trades SET highest_close_since_entry = 100, atr14_at_entry = 3 WHERE id = ?',
    ).run(rowId);

    let t = getOpenPaperTrades(db)[0];
    if (t === undefined) throw new Error('missing trade');
    expect(evaluateOnePaperTrade(t, db, d1, { skipAi: true })).toBe('still_open');

    // Simulates a stop raised in a later pipeline run: replaying day1 with this level would hit low 95.
    db.prepare('UPDATE paper_trades SET stop_loss = ? WHERE id = ?').run(97, rowId);

    t = getOpenPaperTrades(db)[0];
    if (t === undefined) throw new Error('missing trade');
    expect(evaluateOnePaperTrade(t, db, d2, { skipAi: true })).toBe('still_open');
    expect(getOpenPaperTrades(db)).toHaveLength(1);
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
