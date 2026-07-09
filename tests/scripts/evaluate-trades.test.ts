import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as trailingSizing from '../../src/config/trailing-stop-sizing.js';
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

/** Stable sizing for integration scenarios written under 2× / 1.5× @ 15%. */
const legacyTrailSizing = {
  initialMultiplier: 2,
  tightenedMultiplier: 1.5,
  lockInThresholdPct: 15,
} as const;

describe('evaluate paper trades', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    vi.spyOn(trailingSizing, 'trailingStopSizingFromMomentumConfig').mockReturnValue(
      legacyTrailSizing,
    );
    dbPath = join(tmpdir(), `mp-ev-${Date.now()}.db`);
    process.env.DATABASE_PATH = dbPath;
    db = getDb({ path: dbPath });
    migrate(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('same-day SL+TP exits at stop price; status derived from PnL (loss case)', () => {
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
      .prepare('SELECT exit_reason, exit_price, pnl_pct, notes FROM paper_trades WHERE id = ?')
      .get(t.id) as {
      exit_reason: string | null;
      exit_price: number;
      pnl_pct: number;
      notes: string | null;
    };
    expect(row.exit_reason).toBe('INITIAL_STOP');
    // Hard floor lifts LLM stop from 90 → 92 (hard_stop_pct = -8%).
    expect(row.exit_price).toBe(92);
    expect(row.pnl_pct).toBeCloseTo(-8, 4);
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
      const d3 = '2026-09-04';
      seedNifty(d1, d2, d3);
      // d1: initial setup day. d2: trail raises stop to max(108-2×3, 92) = 102.
      // d3: stopAtBarStart = 102. open=89 < 102 → gap-down fill at open.
      upsertQuotes(
        [
          q('GAP92', d1, 100, 112, 100, 108),
          q('GAP92', d2, 109, 110, 106, 108),
          q('GAP92', d3, 89, 105, 88, 104),
        ],
        db,
      );
      seedAtr14('GAP92', [src, d1, d2, d3], 3);
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
      expect(evaluateOnePaperTrade(t, db, d3, { skipAi: true })).toBe('CLOSED_LOSS');

      const closed = db
        .prepare('SELECT status, exit_price, pnl_pct FROM paper_trades WHERE id = ?')
        .get(t.id) as { status: string; exit_price: number; pnl_pct: number };
      expect(closed.status).toBe('CLOSED_LOSS');
      expect(closed.exit_price).toBe(89);
      expect(closed.pnl_pct).toBeCloseTo(-11, 0);

      const logRow = db
        .prepare(
          `SELECT notes, new_stop FROM trailing_stop_log WHERE trade_id = ? AND action = 'STOPPED_OUT'`,
        )
        .get(t.id) as { notes: string | null; new_stop: number };
      expect(logRow?.notes).toBe(GAP_DOWN_THROUGH_STOP_NOTE);
      expect(logRow?.new_stop).toBe(89);
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

  it('fixed stop_type skips trailing-stop math and logs', () => {
    const src = '2026-04-01';
    const d1 = '2026-04-02';
    seedNifty(d1);
    upsertQuotes([q('FIXED1', d1, 100, 104, 95, 99)], db);
    seedAtr14('FIXED1', [src, d1], 3);

    insertPaperTradeIfAbsent(
      {
        symbol: 'FIXED1',
        signalType: 'catalyst_entry',
        sourceDate: src,
        entryPrice: 100,
        stopLoss: 96,
        target: 108,
        timeHorizon: 'short',
        maxHoldDays: 10,
        stopType: 'fixed',
        trailingMultiplier: 0,
      },
      db,
    );
    const t = getOpenPaperTrades(db)[0];
    if (t === undefined) throw new Error('missing trade');
    expect(evaluateOnePaperTrade(t, db, d1, { skipAi: true })).toBe('CLOSED_LOSS');

    const logCount = (
      db.prepare(`SELECT COUNT(*) AS c FROM trailing_stop_log WHERE trade_id = ?`).get(t.id) as {
        c: number;
      }
    ).c;
    expect(logCount).toBe(0);
  });

  it('incremental resume: inflated persisted stop does not replay prior bars (no false stop-out)', () => {
    const src = '2026-04-01';
    const d1 = '2026-04-02';
    const d2 = '2026-04-03';
    seedNifty(d1, d2);
    upsertQuotes([q('RESUME1', d1, 100, 105, 95, 100), q('RESUME1', d2, 100, 105, 99, 100)], db);
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

  describe('gap-up circuit breaker (>30%)', () => {
    it('leaves highest_close unchanged when gap-up is extreme but target not hit', () => {
      const src = '2026-08-01';
      const dPrev = '2026-08-02';
      const dGap = '2026-08-03';
      seedNifty(dPrev, dGap);
      upsertQuotes(
        [q('GAPUP2', dPrev, 100, 100, 100, 100), q('GAPUP2', dGap, 135, 140, 108, 110)],
        db,
      );
      seedAtr14('GAPUP2', [src, dPrev, dGap], 3);
      insertPaperTradeIfAbsent(
        {
          symbol: 'GAPUP2',
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
        db.prepare('SELECT id FROM paper_trades WHERE symbol = ?').get('GAPUP2') as { id: number }
      ).id;
      db.prepare(
        'UPDATE paper_trades SET highest_close_since_entry = 105, atr14_at_entry = 3 WHERE id = ?',
      ).run(rowId);

      const t = getOpenPaperTrades(db)[0];
      if (t === undefined) throw new Error('missing trade');
      expect(evaluateOnePaperTrade(t, db, dGap, { skipAi: true })).toBe('still_open');

      const still = getOpenPaperTrades(db)[0];
      expect(still?.highestCloseSinceEntry).toBe(105);
    });

    it('bar-1 gap-up leaves watermark unset; bar-2 seeds from bar.close', () => {
      const src = '2026-09-01';
      const d1 = '2026-09-02';
      const d2 = '2026-09-03';
      seedNifty(d1, d2);
      upsertQuotes(
        [
          q('GAPB1', src, 100, 100, 100, 100),
          q('GAPB1', d1, 135, 145, 130, 140),
          q('GAPB1', d2, 99, 101, 97, 98),
        ],
        db,
      );
      seedAtr14('GAPB1', [src, d1, d2], 3);
      insertPaperTradeIfAbsent(
        {
          symbol: 'GAPB1',
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
        db.prepare('SELECT id FROM paper_trades WHERE symbol = ?').get('GAPB1') as { id: number }
      ).id;

      let t = getOpenPaperTrades(db)[0];
      if (t === undefined) throw new Error('missing trade');
      expect(evaluateOnePaperTrade(t, db, d1, { skipAi: true })).toBe('still_open');

      const afterBar1 = db
        .prepare('SELECT highest_close_since_entry FROM paper_trades WHERE id = ?')
        .get(rowId) as { highest_close_since_entry: number | null };
      expect(afterBar1.highest_close_since_entry).toBeNull();
      expect(afterBar1.highest_close_since_entry).not.toBe(140);

      t = getOpenPaperTrades(db)[0];
      if (t === undefined) throw new Error('missing trade');
      expect(evaluateOnePaperTrade(t, db, d2, { skipAi: true })).toBe('still_open');

      const still = getOpenPaperTrades(db)[0];
      expect(still?.highestCloseSinceEntry).toBe(98);
    });

    it('gap-up same bar still stop-outs when low breaches stop', () => {
      const src = '2026-09-01';
      const dPrev = '2026-09-02';
      const dGap = '2026-09-03';
      seedNifty(dPrev, dGap);
      upsertQuotes([q('GAPSL', dPrev, 100, 100, 100, 100), q('GAPSL', dGap, 135, 136, 88, 95)], db);
      seedAtr14('GAPSL', [src, dPrev, dGap], 3);
      insertPaperTradeIfAbsent(
        {
          symbol: 'GAPSL',
          signalType: 'AI_PICK',
          sourceDate: src,
          entryPrice: 100,
          stopLoss: 92,
          target: 200,
          timeHorizon: 'medium',
          maxHoldDays: 90,
        },
        db,
      );
      const rowId = (
        db.prepare('SELECT id FROM paper_trades WHERE symbol = ?').get('GAPSL') as { id: number }
      ).id;
      db.prepare(
        'UPDATE paper_trades SET highest_close_since_entry = 105, atr14_at_entry = 3 WHERE id = ?',
      ).run(rowId);

      const t = getOpenPaperTrades(db)[0];
      if (t === undefined) throw new Error('missing trade');
      expect(evaluateOnePaperTrade(t, db, dGap, { skipAi: true })).toBe('CLOSED_LOSS');

      const closed = db
        .prepare('SELECT status, exit_reason FROM paper_trades WHERE id = ?')
        .get(rowId) as { status: string; exit_reason: string | null };
      expect(closed.status).toBe('CLOSED_LOSS');
      expect(closed.exit_reason).toBe('TRAILING_STOP');
    });

    it('updates highest_close normally when gap-up is under 30% threshold', () => {
      const src = '2026-08-01';
      const dPrev = '2026-08-02';
      const dBar = '2026-08-03';
      seedNifty(dPrev, dBar);
      upsertQuotes(
        // low must clear raised trailing stop (~124) after close updates watermark to 130
        [q('GAPUP3', dPrev, 100, 100, 100, 100), q('GAPUP3', dBar, 125, 135, 126, 130)],
        db,
      );
      seedAtr14('GAPUP3', [src, dPrev, dBar], 3);
      insertPaperTradeIfAbsent(
        {
          symbol: 'GAPUP3',
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
        db.prepare('SELECT id FROM paper_trades WHERE symbol = ?').get('GAPUP3') as { id: number }
      ).id;
      db.prepare(
        'UPDATE paper_trades SET highest_close_since_entry = 105, atr14_at_entry = 3 WHERE id = ?',
      ).run(rowId);

      const t = getOpenPaperTrades(db)[0];
      if (t === undefined) throw new Error('missing trade');
      expect(evaluateOnePaperTrade(t, db, dBar, { skipAi: true })).toBe('still_open');

      const still = getOpenPaperTrades(db)[0];
      expect(still?.highestCloseSinceEntry).toBe(130);
    });
  });

  it('null prevClose on first symbol bar skips gap CB and runs trailing', () => {
    const src = '2026-10-01';
    const d1 = '2026-10-02';
    seedNifty(d1);
    upsertQuotes([q('NOPREV', d1, 100, 108, 99, 106)], db);
    seedAtr14('NOPREV', [src, d1], 3);
    insertPaperTradeIfAbsent(
      {
        symbol: 'NOPREV',
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
      db.prepare('SELECT id FROM paper_trades WHERE symbol = ?').get('NOPREV') as { id: number }
    ).id;

    const t = getOpenPaperTrades(db)[0];
    if (t === undefined) throw new Error('missing trade');
    expect(evaluateOnePaperTrade(t, db, d1, { skipAi: true })).toBe('still_open');

    const still = getOpenPaperTrades(db)[0];
    expect(still?.highestCloseSinceEntry).toBe(106);
    expect(still?.atr14AtEntry).toBe(3);

    const trailLogCount = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM trailing_stop_log WHERE trade_id = ? AND log_date = ?`)
        .get(rowId, d1) as { c: number }
    ).c;
    expect(trailLogCount).toBe(0);
  });

  it('Day-1 ATR latch uses next open session when sourceDate is Sunday', () => {
    const srcSunday = '2026-02-01';
    const dMonday = '2026-02-02';
    seedNifty(dMonday);
    upsertQuotes([q('SUNATR', dMonday, 100, 105, 98, 102)], db);
    seedAtr14('SUNATR', [dMonday], 4);

    insertPaperTradeIfAbsent(
      {
        symbol: 'SUNATR',
        signalType: 'AI_PICK',
        sourceDate: srcSunday,
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
    expect(evaluateOnePaperTrade(t, db, dMonday, { skipAi: true })).toBe('still_open');

    const still = getOpenPaperTrades(db)[0];
    // ATR-based: 100 - 2×4 = 92 (tighter than LLM 90).
    expect(still?.stopLoss).toBe(92);
    expect(still?.atr14AtEntry).toBe(4);
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

  // ──────────────────────────────────────────────────────────────────────────
  // Data integrity: stop-hit checks use bar-start stop, not post-trail stop
  // ──────────────────────────────────────────────────────────────────────────

  describe('stop-hit uses stopAtBarStart (trail-then-check order)', () => {
    /**
     * SUPRIYA reproduction: stock gaps up, bar.close is much higher than prior
     * highest close, trail ratchets stop far above bar.low using the new close.
     * Pre-fix: trail updated stop using bar.close, then checked bar.low <= new
     * stop → false stop-out with positive PnL tagged CLOSED_LOSS.
     * Post-fix: hit check uses stopAtBarStart; trail only affects next bar.
     */
    it('gap-up bar does NOT false-trigger stop when trail ratchets above bar.low', () => {
      const src = '2026-05-19';
      const d1 = '2026-05-20';
      const d2 = '2026-05-21';
      const d3 = '2026-05-22';
      seedNifty(d1, d2, d3);
      upsertQuotes(
        [
          q('SUPBUG', d1, 100, 105, 98, 104),
          q('SUPBUG', d2, 105, 112, 103, 110),
          // Gap-up bar: opens at 130, dips to 118, closes 140.
          // Old stop (before trail) ≈ 104 (highestClose=110, 110 - 2×3 = 104).
          // Trail using close=140 would push stop to 140 - 2×3 = 134 > low 118 → false exit.
          // Fix: hit check uses stopAtBarStart (~104), bar.low 118 > 104 → stays open.
          q('SUPBUG', d3, 130, 145, 118, 140),
        ],
        db,
      );
      seedAtr14('SUPBUG', [src, d1, d2, d3], 3);
      insertPaperTradeIfAbsent(
        {
          symbol: 'SUPBUG',
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
      if (!t) throw new Error('missing trade');
      expect(evaluateOnePaperTrade(t, db, d3, { skipAi: true })).toBe('still_open');

      const still = getOpenPaperTrades(db)[0];
      // Trail should have updated to reflect bar.close=140 for NEXT bar's stop
      expect(still?.highestCloseSinceEntry).toBe(140);
      // Stop is raised (trail applied for persistence), but hit was checked against old stop
      expect(still?.stopLoss).toBeGreaterThan(104);
    });

    it('stop-out still fires when bar.low <= stopAtBarStart (normal case)', () => {
      const src = '2026-05-19';
      const d1 = '2026-05-20';
      const d2 = '2026-05-21';
      seedNifty(d1, d2);
      upsertQuotes(
        [
          q('SLHIT', d1, 100, 108, 99, 106),
          // Bar.low 93 <= stopAtBarStart (after trail from day1: 106 - 2×3 = 100)
          q('SLHIT', d2, 102, 105, 93, 95),
        ],
        db,
      );
      seedAtr14('SLHIT', [src, d1, d2], 3);
      insertPaperTradeIfAbsent(
        {
          symbol: 'SLHIT',
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
      if (!t) throw new Error('missing trade');
      expect(evaluateOnePaperTrade(t, db, d2, { skipAi: true })).toBe('CLOSED_LOSS');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Same-day SL+TP: status derived from PnL, not hard-coded
  // ──────────────────────────────────────────────────────────────────────────

  describe('same-day SL+TP pnl-based status', () => {
    it('same-day SL+TP with profitable stop → CLOSED_WIN (trailing, stop above entry)', () => {
      const src = '2026-06-01';
      const d1 = '2026-06-02';
      const d2 = '2026-06-03';
      const d3 = '2026-06-04';
      seedNifty(d1, d2, d3);
      upsertQuotes(
        [
          q('SLTP_W', d1, 100, 108, 99, 106),
          q('SLTP_W', d2, 107, 120, 106, 118),
          // On d3: stopAtBarStart ≈ 112 (from highestClose=118, 118-2×3=112).
          // bar.low=111 <= 112 → SL hit. bar.close=125 >= target=120 → TP hit.
          // exitPx = stopAtBarStart = 112 (open 113 >= stop 112).
          // pnl = (112-100)/100 = +12% → CLOSED_WIN
          q('SLTP_W', d3, 113, 126, 111, 125),
        ],
        db,
      );
      seedAtr14('SLTP_W', [src, d1, d2, d3], 3);
      insertPaperTradeIfAbsent(
        {
          symbol: 'SLTP_W',
          signalType: 'AI_PICK',
          sourceDate: src,
          entryPrice: 100,
          stopLoss: 85,
          target: 120,
          timeHorizon: 'medium',
          maxHoldDays: 90,
        },
        db,
      );
      const t = getOpenPaperTrades(db)[0];
      if (!t) throw new Error('missing trade');
      expect(evaluateOnePaperTrade(t, db, d3, { skipAi: true })).toBe('CLOSED_WIN');

      const row = db
        .prepare(
          'SELECT status, exit_price, pnl_pct, exit_reason, notes FROM paper_trades WHERE id = ?',
        )
        .get(t.id) as {
        status: string;
        exit_price: number;
        pnl_pct: number;
        exit_reason: string;
        notes: string;
      };
      expect(row.status).toBe('CLOSED_WIN');
      expect(row.pnl_pct).toBeGreaterThan(0);
      expect(row.exit_reason).toBe('TRAILING_STOP');
      expect(row.notes).toContain('same-day SL+TP');
    });

    it('same-day SL+TP with losing stop → CLOSED_LOSS (fixed stop)', () => {
      seedNifty('2026-02-02');
      // entry=100, stop=90, target=120. bar low=85 hits stop, close=125 hits target.
      // exitPx = 90 (open 100 >= stop 90). pnl = -10% → CLOSED_LOSS.
      upsertQuotes([q('SLTP_L', '2026-02-02', 100, 130, 85, 125)], db);
      insertPaperTradeIfAbsent(
        {
          symbol: 'SLTP_L',
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
      const t = getOpenPaperTrades(db)[0];
      if (!t) throw new Error('missing trade');
      expect(evaluateOnePaperTrade(t, db, '2026-02-02', { skipAi: true })).toBe('CLOSED_LOSS');

      const row = db.prepare('SELECT status, pnl_pct FROM paper_trades WHERE id = ?').get(t.id) as {
        status: string;
        pnl_pct: number;
      };
      expect(row.status).toBe('CLOSED_LOSS');
      expect(row.pnl_pct).toBeLessThan(0);
    });

    it('same-day SL+TP with gap-down through profitable stop → CLOSED_WIN at open', () => {
      const src = '2026-06-01';
      const d1 = '2026-06-02';
      const d2 = '2026-06-03';
      const d3 = '2026-06-04';
      seedNifty(d1, d2, d3);
      upsertQuotes(
        [
          q('GAPSL', d1, 100, 108, 99, 106),
          // d2: trail raises stop. highestClose = max(106, 122) = 122.
          // stop = max(122 - 2×3, 92) = 116. Target 125 not hit (close=122 < 125).
          q('GAPSL', d2, 107, 123, 106, 122),
          // d3: stopAtBarStart = 116. open=114 < 116 → gap-down exit at 114.
          // pnl = (114-100)/100 = +14% → CLOSED_WIN despite gap-through.
          // bar.close=130 >= target=125 → TP also hit → same-day SL+TP.
          q('GAPSL', d3, 114, 132, 112, 130),
        ],
        db,
      );
      seedAtr14('GAPSL', [src, d1, d2, d3], 3);
      insertPaperTradeIfAbsent(
        {
          symbol: 'GAPSL',
          signalType: 'AI_PICK',
          sourceDate: src,
          entryPrice: 100,
          stopLoss: 85,
          target: 125,
          timeHorizon: 'medium',
          maxHoldDays: 90,
        },
        db,
      );
      const t = getOpenPaperTrades(db)[0];
      if (!t) throw new Error('missing trade');
      expect(evaluateOnePaperTrade(t, db, d3, { skipAi: true })).toBe('CLOSED_WIN');

      const row = db
        .prepare('SELECT status, exit_price, pnl_pct FROM paper_trades WHERE id = ?')
        .get(t.id) as { status: string; exit_price: number; pnl_pct: number };
      expect(row.status).toBe('CLOSED_WIN');
      expect(row.exit_price).toBe(114); // gap-through: fill at open
      expect(row.pnl_pct).toBeGreaterThan(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Stats integrity: win/loss status must always agree with PnL sign
  // ──────────────────────────────────────────────────────────────────────────

  describe('stats integrity', () => {
    it('profitable trailing stop exit is CLOSED_WIN and counts as win in stats', () => {
      const d1 = '2026-07-02';
      const d2 = '2026-07-03';
      const d3 = '2026-07-04';
      seedNifty(d1, d2, d3);
      upsertQuotes(
        [
          q('WINST', d1, 100, 112, 99, 110),
          q('WINST', d2, 111, 120, 109, 118),
          // stopAtBarStart ≈ 112 (118-2×3=112). low=111 <= 112 → stopped out.
          // exitPx = 112 (open 113 >= stop). pnl = +12% → WIN.
          q('WINST', d3, 113, 115, 111, 114),
        ],
        db,
      );
      seedAtr14('WINST', ['2026-07-01', d1, d2, d3], 3);
      insertPaperTradeIfAbsent(
        {
          symbol: 'WINST',
          signalType: 'AI_PICK',
          sourceDate: '2026-07-01',
          entryPrice: 100,
          stopLoss: 85,
          target: 200,
          timeHorizon: 'medium',
          maxHoldDays: 90,
        },
        db,
      );
      const t = getOpenPaperTrades(db)[0];
      if (!t) throw new Error('missing trade');
      evaluateOnePaperTrade(t, db, d3, { skipAi: true });

      const row = db
        .prepare('SELECT status, pnl_pct, exit_reason FROM paper_trades WHERE id = ?')
        .get(t.id) as { status: string; pnl_pct: number; exit_reason: string };
      expect(row.status).toBe('CLOSED_WIN');
      expect(row.pnl_pct).toBeGreaterThan(0);
      expect(row.exit_reason).toBe('TRAILING_STOP');

      const stats = getPaperTradeStats({ days: 30, asOf: d3 }, db);
      expect(stats.winCount).toBe(1);
      expect(stats.lossCount).toBe(0);
      // winRate is null when closedCount < MIN_SAMPLE_CLOSED (5)
      expect(stats.closedCount).toBe(1);
    });

    it('losing trailing stop exit is CLOSED_LOSS and counts as loss in stats', () => {
      const src = '2026-07-01';
      const d1 = '2026-07-02';
      seedNifty(d1);
      upsertQuotes([q('LOSST', d1, 100, 103, 88, 90)], db);
      seedAtr14('LOSST', [src, d1], 3);
      insertPaperTradeIfAbsent(
        {
          symbol: 'LOSST',
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
      if (!t) throw new Error('missing trade');
      evaluateOnePaperTrade(t, db, d1, { skipAi: true });

      const row = db.prepare('SELECT status, pnl_pct FROM paper_trades WHERE id = ?').get(t.id) as {
        status: string;
        pnl_pct: number;
      };
      expect(row.status).toBe('CLOSED_LOSS');
      expect(row.pnl_pct).toBeLessThan(0);

      const stats = getPaperTradeStats({ days: 30, asOf: d1 }, db);
      expect(stats.lossCount).toBe(1);
      expect(stats.winCount).toBe(0);
    });

    it('multiple trades: win rate matches actual positive-pnl count', () => {
      seedNifty('2026-08-02');
      // Trade 1: target hit → WIN (+20%)
      upsertQuotes([q('MR_W', '2026-08-02', 100, 125, 95, 122)], db);
      insertPaperTradeIfAbsent(
        {
          symbol: 'MR_W',
          signalType: 'AI_PICK',
          sourceDate: '2026-08-01',
          entryPrice: 100,
          stopLoss: 90,
          target: 120,
          timeHorizon: 'medium',
          maxHoldDays: 90,
        },
        db,
      );
      // Trade 2: stop hit → LOSS (-10%)
      upsertQuotes([q('MR_L', '2026-08-02', 100, 105, 85, 88)], db);
      insertPaperTradeIfAbsent(
        {
          symbol: 'MR_L',
          signalType: 'AI_PICK',
          sourceDate: '2026-08-01',
          entryPrice: 100,
          stopLoss: 90,
          target: 120,
          timeHorizon: 'medium',
          maxHoldDays: 90,
        },
        db,
      );

      const r = runEvaluatePaperTrades('2026-08-02', db, { skipAi: true });
      expect(r.closedWin).toBe(1);
      expect(r.closedLoss).toBe(1);

      const stats = getPaperTradeStats({ days: 30, asOf: '2026-08-02' }, db);
      expect(stats.closedCount).toBe(2);
      expect(stats.winCount).toBe(1);
      expect(stats.lossCount).toBe(1);
      // winRate requires MIN_SAMPLE_CLOSED=5; with only 2 trades it's null
      expect(stats.winRate).toBeNull();
      expect(stats.expectancyPct).toBeDefined();
    });
  });
});
