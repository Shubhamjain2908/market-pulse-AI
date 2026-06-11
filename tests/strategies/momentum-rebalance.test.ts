import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockWarn = vi.hoisted(() => vi.fn());
const mockInfo = vi.hoisted(() => vi.fn());
const noop = vi.hoisted(() => vi.fn());

vi.mock('../../src/logger.js', () => {
  const stub = () => ({
    warn: mockWarn,
    error: noop,
    info: mockInfo,
    debug: noop,
    child: stub,
  });
  return { child: stub, logger: stub() };
});

import { loadStrategyGates } from '../../src/config/loaders.js';
import { closeDb, getDb, migrate } from '../../src/db/index.js';
import { getOpenPaperTradesForSignal } from '../../src/db/queries.js';
import { seedStrategyGates } from '../../src/db/regime-queries.js';
import type { LlmProvider } from '../../src/llm/types.js';
import {
  applyMomentumRegimeGateExits,
  runMomentumRebalance,
  toMomentumRebalanceBriefingSummary,
} from '../../src/strategies/momentum-rebalance.js';

function insertRegimeBull(db: ReturnType<typeof getDb>, sessionDate: string): void {
  db.prepare(
    `
    INSERT INTO regime_daily (
      date, regime, score_total, score_trend, score_vix, score_fii, score_breadth,
      vix_value, nifty_vs_sma200, fii_20d_net, crisis_override, regime_age
    ) VALUES (?, 'BULL_TRENDING', 8, 2, 1, 1, 1, 14, 2, 100, 0, 3)
  `,
  ).run(sessionDate);
}

function insertRegimeChoppy(db: ReturnType<typeof getDb>, sessionDate: string): void {
  db.prepare(
    `
    INSERT INTO regime_daily (
      date, regime, score_total, score_trend, score_vix, score_fii, score_breadth,
      vix_value, nifty_vs_sma200, fii_20d_net, crisis_override, regime_age
    ) VALUES (?, 'CHOPPY', 0, 0, 0, 0, 0, 16, 0, 0, 0, 1)
  `,
  ).run(sessionDate);
}

function quote(db: ReturnType<typeof getDb>, sym: string, date: string, close: number): void {
  db.prepare(
    `
    INSERT INTO quotes (symbol, exchange, date, open, high, low, close, volume, source)
    VALUES (?, 'NSE', ?, ?, ?, ?, ?, 1000, 'test')
  `,
  ).run(sym, date, close, close, close, close);
}

function sigRank(db: ReturnType<typeof getDb>, sym: string, date: string, rank: number): void {
  db.prepare(
    `INSERT INTO signals (symbol, date, name, value, source) VALUES (?, ?, 'mom_rank', ?, 'test')`,
  ).run(sym, date, rank);
}

function sigAtr14(db: ReturnType<typeof getDb>, sym: string, date: string, value: number): void {
  db.prepare(
    `INSERT INTO signals (symbol, date, name, value, source) VALUES (?, ?, 'atr_14', ?, 'test')`,
  ).run(sym, date, value);
}

describe('strategies/momentum-rebalance', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-mom-rebal-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = dbPath;
    mockWarn.mockClear();
    mockInfo.mockClear();
  });

  function openMomentumTestDb(): ReturnType<typeof getDb> {
    const db = getDb({ path: dbPath });
    migrate(db);
    seedStrategyGates(loadStrategyGates({ fresh: true }).rows, db);
    return db;
  }

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

  it('applyMomentumRegimeGateExits closes open momentum_mf when regime ∉ gate', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    const session = '2026-05-08';
    quote(db, 'ZZZ', session, 110);
    db.prepare(
      `
      INSERT INTO paper_trades (
        symbol, signal_type, source_date, entry_price, stop_loss, target,
        time_horizon, max_hold_days, status
      ) VALUES ('ZZZ', 'momentum_mf', '2026-04-01', 100, 92, 115, 'medium', 90, 'OPEN')
    `,
    ).run();
    expect(getOpenPaperTradesForSignal('momentum_mf', db)).toHaveLength(1);

    const n = applyMomentumRegimeGateExits({
      calendarDate: session,
      regime: 'CHOPPY',
      db,
    });
    expect(n).toBe(1);
    expect(getOpenPaperTradesForSignal('momentum_mf', db)).toHaveLength(0);
    db.close();
  });

  it('runMomentumRebalance gates in non-bull regime (no rebalance writes)', async () => {
    const db = openMomentumTestDb();
    const session = '2026-05-08';
    insertRegimeChoppy(db, session);
    quote(db, 'ZZZ', session, 105);
    db.prepare(
      `
      INSERT INTO paper_trades (
        symbol, signal_type, source_date, entry_price, stop_loss, target,
        time_horizon, max_hold_days, status
      ) VALUES ('ZZZ', 'momentum_mf', '2026-04-01', 100, 92, 115, 'medium', 90, 'OPEN')
    `,
    ).run();

    const r = await runMomentumRebalance({
      calendarDate: session,
      db,
      skipRanker: true,
      skipThesis: true,
    });
    expect(r.regimeAllowed).toBe(false);
    expect(r.skippedReason).toBe('regime_gate');
    expect(getOpenPaperTradesForSignal('momentum_mf', db)).toHaveLength(1);
    db.close();
  });

  it('exits holdings when mom_rank > exit_rank_threshold', async () => {
    const db = openMomentumTestDb();
    const session = '2026-05-08';
    insertRegimeBull(db, session);
    quote(db, 'OLD', session, 100);
    sigRank(db, 'OLD', session, 21);
    db.prepare(
      `
      INSERT INTO paper_trades (
        symbol, signal_type, source_date, entry_price, stop_loss, target,
        time_horizon, max_hold_days, status
      ) VALUES ('OLD', 'momentum_mf', '2026-04-01', 100, 92, 115, 'medium', 90, 'OPEN')
    `,
    ).run();

    const r = await runMomentumRebalance({
      calendarDate: session,
      db,
      skipRanker: true,
      skipThesis: true,
    });
    expect(r.closedRankDecay).toBe(1);
    expect(getOpenPaperTradesForSignal('momentum_mf', db)).toHaveLength(0);
    db.close();
  });

  it('skips sector-cap fourth name and promotes next sector', async () => {
    const db = openMomentumTestDb();
    const session = '2026-05-08';
    insertRegimeBull(db, session);
    for (const s of ['AA', 'BB', 'CC', 'DD', 'EE']) {
      quote(db, s, session, 100);
      sigAtr14(db, s, session, 2);
      db.prepare('INSERT INTO symbols (symbol, sector) VALUES (?, ?)').run(s, 'Banking');
    }
    db.prepare(`INSERT INTO symbols (symbol, sector) VALUES ('FF', 'IT Services')`).run();
    quote(db, 'FF', session, 100);
    sigAtr14(db, 'FF', session, 2);

    sigRank(db, 'AA', session, 1);
    sigRank(db, 'BB', session, 2);
    sigRank(db, 'CC', session, 3);
    sigRank(db, 'DD', session, 4);
    sigRank(db, 'EE', session, 5);
    sigRank(db, 'FF', session, 6);

    const r = await runMomentumRebalance({
      calendarDate: session,
      db,
      skipRanker: true,
      skipThesis: true,
    });
    expect(r.entriesInserted).toBe(4);
    expect(r.sectorCapBlocked).toBeGreaterThanOrEqual(2);
    const open = getOpenPaperTradesForSignal('momentum_mf', db).map((t) => t.symbol);
    expect(open).toContain('AA');
    expect(open).toContain('BB');
    expect(open).toContain('CC');
    expect(open).toContain('FF');
    expect(open).not.toContain('DD');
    expect(open).not.toContain('EE');
    db.close();
  });

  it('blocks blackout symbols and takes next rank', async () => {
    const db = openMomentumTestDb();
    const session = '2026-05-08';
    insertRegimeBull(db, session);
    quote(db, 'P', session, 50);
    quote(db, 'Q', session, 50);
    sigAtr14(db, 'P', session, 2);
    sigAtr14(db, 'Q', session, 2);
    sigRank(db, 'P', session, 1);
    sigRank(db, 'Q', session, 2);
    db.prepare(
      `
      INSERT INTO earnings_calendar (symbol, expected_date, source, fetched_at)
      VALUES ('P', ?, 'test', ?)
    `,
    ).run(session, session);

    const r = await runMomentumRebalance({
      calendarDate: session,
      db,
      skipRanker: true,
      skipThesis: true,
    });
    expect(r.blackoutBlocked).toBeGreaterThanOrEqual(1);
    const open = getOpenPaperTradesForSignal('momentum_mf', db).map((t) => t.symbol);
    expect(open).toContain('Q');
    expect(open).not.toContain('P');
    db.close();
  });

  it('writes entries using thesis + ATR-integrated stop path', async () => {
    const db = openMomentumTestDb();
    const session = '2026-05-08';
    insertRegimeBull(db, session);
    quote(db, 'THX', session, 100);
    sigRank(db, 'THX', session, 1);
    db.prepare(
      `INSERT INTO signals (symbol, date, name, value, source) VALUES ('THX', ?, 'atr_14', 5, 'test')`,
    ).run(session);
    db.prepare(
      `INSERT INTO signals (symbol, date, name, value, source) VALUES ('THX', ?, 'mom_composite_score', 1.23, 'test')`,
    ).run(session);
    db.prepare(
      `INSERT INTO signals (symbol, date, name, value, source) VALUES ('THX', ?, 'mom_false_flag', 0, 'test')`,
    ).run(session);

    const llm: LlmProvider = {
      name: 'mock',
      model: 'mock-1',
      async generateText() {
        return { text: 'ok', usage: { durationMs: 1 }, model: 'mock-1' };
      },
      async generateJson<T>() {
        return {
          data: {
            symbol: 'THX',
            thesis: 'Strong setup with improving breadth and momentum confirmation.',
            bullCase: ['Trend continuation'],
            bearCase: ['Failed breakout'],
            entryZone: '₹98-₹102',
            stopLoss: '₹88',
            target: '₹130',
            timeHorizon: 'medium',
            confidenceScore: 7,
            triggerScreen: 'momentum',
          } as T,
          raw: '{}',
          usage: { durationMs: 1 },
          model: 'mock-1',
        };
      },
    };

    const r = await runMomentumRebalance({
      calendarDate: session,
      db,
      skipRanker: true,
      llm,
    });
    expect(r.entriesInserted).toBe(1);
    const open = getOpenPaperTradesForSignal('momentum_mf', db);
    expect(open).toHaveLength(1);
    const trade = open[0];
    expect(trade?.stopLoss).toBe(92); // max(hard floor 92, atr stop 90, thesis stop 88)
    expect(trade?.target).toBe(130);
    expect(trade?.notes).toContain('"atr14":5');
    db.close();
  });

  it('hard-blocks entry when mom_false_flag is set; allows clean rank through', async () => {
    const db = openMomentumTestDb();
    const session = '2026-05-08';
    insertRegimeBull(db, session);
    quote(db, 'FFX', session, 100);
    quote(db, 'GOOD', session, 100);
    sigAtr14(db, 'GOOD', session, 2);
    sigRank(db, 'FFX', session, 1);
    sigRank(db, 'GOOD', session, 2);
    db.prepare(
      `INSERT INTO signals (symbol, date, name, value, source) VALUES ('FFX', ?, 'mom_false_flag', 1, 'test')`,
    ).run(session);
    db.prepare(
      `INSERT INTO signals (symbol, date, name, value, source) VALUES ('GOOD', ?, 'mom_false_flag', 0, 'test')`,
    ).run(session);

    const r = await runMomentumRebalance({
      calendarDate: session,
      db,
      skipRanker: true,
      skipThesis: true,
    });
    expect(r.falseFlagBlocked).toBe(1);
    expect(r.entriesInserted).toBe(1);
    const open = getOpenPaperTradesForSignal('momentum_mf', db).map((t) => t.symbol);
    expect(open).not.toContain('FFX');
    expect(open).toContain('GOOD');
    db.close();
  });

  it('rejects entry when atr_14 signal is missing', async () => {
    const db = openMomentumTestDb();
    const session = '2026-05-08';
    insertRegimeBull(db, session);
    quote(db, 'ATR', session, 100);
    sigRank(db, 'ATR', session, 1);
    db.prepare(
      `INSERT INTO signals (symbol, date, name, value, source) VALUES ('ATR', ?, 'mom_composite_score', 1, 'test')`,
    ).run(session);
    db.prepare(
      `INSERT INTO signals (symbol, date, name, value, source) VALUES ('ATR', ?, 'mom_false_flag', 0, 'test')`,
    ).run(session);

    const r = await runMomentumRebalance({
      calendarDate: session,
      db,
      skipRanker: true,
      skipThesis: true,
    });
    expect(r.entriesInserted).toBe(0);
    expect(r.atrMissingSkipped).toBe(1);
    expect(getOpenPaperTradesForSignal('momentum_mf', db)).toHaveLength(0);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'ATR', source_date: session, reason: 'atr14_missing' }),
      expect.stringContaining('ATR14'),
    );
    db.close();
  });

  it('rejects entry when atr_14 is zero', async () => {
    const db = openMomentumTestDb();
    const session = '2026-05-08';
    insertRegimeBull(db, session);
    quote(db, 'ZATR', session, 100);
    sigRank(db, 'ZATR', session, 1);
    sigAtr14(db, 'ZATR', session, 0);

    const r = await runMomentumRebalance({
      calendarDate: session,
      db,
      skipRanker: true,
      skipThesis: true,
    });
    expect(r.entriesInserted).toBe(0);
    expect(r.atrMissingSkipped).toBe(1);
    expect(getOpenPaperTradesForSignal('momentum_mf', db)).toHaveLength(0);
    db.close();
  });

  it('blocks momentum_mf entry when OPEN AI_PICK exists for the symbol', async () => {
    const db = openMomentumTestDb();
    const session = '2026-05-08';
    insertRegimeBull(db, session);
    quote(db, 'INFY', session, 100);
    sigRank(db, 'INFY', session, 1);
    sigAtr14(db, 'INFY', session, 2);
    db.prepare(
      `
      INSERT INTO paper_trades (
        symbol, signal_type, source_date, entry_price, stop_loss, target,
        time_horizon, max_hold_days, status
      ) VALUES ('INFY', 'AI_PICK', '2026-05-01', 100, 95, 120, 'medium', 90, 'OPEN')
    `,
    ).run();

    const r = await runMomentumRebalance({
      calendarDate: session,
      db,
      skipRanker: true,
      skipThesis: true,
    });
    expect(r.entriesInserted).toBe(0);
    expect(r.crossStrategyBlocked).toBe(1);
    expect(getOpenPaperTradesForSignal('momentum_mf', db)).toHaveLength(0);
    expect(mockInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'INFY',
        signalType: 'momentum_mf',
        blockReason: 'open_in_other_strategy',
      }),
      'paper trade dedup — symbol already open under different signal',
    );
    db.close();
  });

  it('second rebalance is idempotent (no duplicate inserts)', async () => {
    const db = openMomentumTestDb();
    const session = '2026-05-08';
    insertRegimeBull(db, session);
    quote(db, 'ONLY', session, 75);
    sigRank(db, 'ONLY', session, 1);
    sigAtr14(db, 'ONLY', session, 2);

    const a = await runMomentumRebalance({
      calendarDate: session,
      db,
      skipRanker: true,
      skipThesis: true,
    });
    const b = await runMomentumRebalance({
      calendarDate: session,
      db,
      skipRanker: true,
      skipThesis: true,
    });
    expect(a.entriesInserted).toBe(1);
    expect(b.entriesInserted).toBe(0);
    expect(getOpenPaperTradesForSignal('momentum_mf', db)).toHaveLength(1);
    db.close();
  });
});

describe('toMomentumRebalanceBriefingSummary', () => {
  it('includes counters and regime when rebalance was regime-gated', () => {
    expect(
      toMomentumRebalanceBriefingSummary({
        calendarDate: '2026-05-03',
        sessionDate: '2026-05-01',
        regime: 'CHOPPY',
        regimeAllowed: false,
        rankerRan: true,
        closedRankDecay: 0,
        entriesInserted: 0,
        sectorCapBlocked: 0,
        blackoutBlocked: 0,
        falseFlagBlocked: 0,
        atrMissingSkipped: 0,
        crossStrategyBlocked: 0,
        unchangedHeld: 1,
        thesisFailed: 0,
        skippedReason: 'regime_gate',
      }),
    ).toEqual({
      calendarDate: '2026-05-03',
      sessionDate: '2026-05-01',
      regimeAllowed: false,
      regime: 'CHOPPY',
      closedRankDecay: 0,
      entriesInserted: 0,
      unchangedHeld: 1,
      sectorCapBlocked: 0,
      blackoutBlocked: 0,
      falseFlagBlocked: 0,
      crossStrategyBlocked: 0,
      skippedReason: 'regime_gate',
      thesisFailed: 0,
    });
  });

  it('maps counters when regime allowed', () => {
    expect(
      toMomentumRebalanceBriefingSummary({
        calendarDate: '2026-05-03',
        sessionDate: '2026-05-01',
        regime: 'BULL_TRENDING',
        regimeAllowed: true,
        rankerRan: true,
        closedRankDecay: 2,
        entriesInserted: 1,
        sectorCapBlocked: 0,
        blackoutBlocked: 1,
        falseFlagBlocked: 0,
        atrMissingSkipped: 0,
        crossStrategyBlocked: 0,
        unchangedHeld: 3,
        thesisFailed: 0,
      }),
    ).toEqual({
      calendarDate: '2026-05-03',
      sessionDate: '2026-05-01',
      regimeAllowed: true,
      regime: 'BULL_TRENDING',
      closedRankDecay: 2,
      entriesInserted: 1,
      unchangedHeld: 3,
      sectorCapBlocked: 0,
      blackoutBlocked: 1,
      falseFlagBlocked: 0,
      crossStrategyBlocked: 0,
      thesisFailed: 0,
    });
  });
});
