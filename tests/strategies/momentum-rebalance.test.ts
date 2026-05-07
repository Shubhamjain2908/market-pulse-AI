import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, migrate } from '../../src/db/index.js';
import { getOpenPaperTradesForSignal } from '../../src/db/queries.js';
import {
  applyMomentumRegimeGateExits,
  runMomentumRebalance,
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

function sigBlackout(db: ReturnType<typeof getDb>, sym: string, date: string, v: number): void {
  db.prepare(
    `
    INSERT INTO signals (symbol, date, name, value, source)
    VALUES (?, ?, 'mom_earnings_blackout', ?, 'test')
  `,
  ).run(sym, date, v);
}

describe('strategies/momentum-rebalance', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-mom-rebal-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = dbPath;
  });

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

  it('runMomentumRebalance liquidates when regime is non-bull', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
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

    const r = runMomentumRebalance({
      calendarDate: session,
      db,
      skipRanker: true,
    });
    expect(r.regimeAllowed).toBe(false);
    expect(r.closedRegime).toBe(1);
    expect(getOpenPaperTradesForSignal('momentum_mf', db)).toHaveLength(0);
    db.close();
  });

  it('exits holdings when mom_rank > exit_rank_threshold', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
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

    const r = runMomentumRebalance({ calendarDate: session, db, skipRanker: true });
    expect(r.closedRankDecay).toBe(1);
    expect(getOpenPaperTradesForSignal('momentum_mf', db)).toHaveLength(0);
    db.close();
  });

  it('skips sector-cap fourth name and promotes next sector', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    const session = '2026-05-08';
    insertRegimeBull(db, session);
    for (const s of ['AA', 'BB', 'CC', 'DD', 'EE']) {
      quote(db, s, session, 100);
      db.prepare('INSERT INTO symbols (symbol, sector) VALUES (?, ?)').run(s, 'Banking');
    }
    db.prepare(`INSERT INTO symbols (symbol, sector) VALUES ('FF', 'IT Services')`).run();
    quote(db, 'FF', session, 100);

    sigRank(db, 'AA', session, 1);
    sigRank(db, 'BB', session, 2);
    sigRank(db, 'CC', session, 3);
    sigRank(db, 'DD', session, 4);
    sigRank(db, 'EE', session, 5);
    sigRank(db, 'FF', session, 6);

    const r = runMomentumRebalance({ calendarDate: session, db, skipRanker: true });
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

  it('blocks blackout symbols and takes next rank', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    const session = '2026-05-08';
    insertRegimeBull(db, session);
    quote(db, 'P', session, 50);
    quote(db, 'Q', session, 50);
    sigRank(db, 'P', session, 1);
    sigBlackout(db, 'P', session, 1);
    sigRank(db, 'Q', session, 2);

    const r = runMomentumRebalance({ calendarDate: session, db, skipRanker: true });
    expect(r.blackoutBlocked).toBeGreaterThanOrEqual(1);
    const open = getOpenPaperTradesForSignal('momentum_mf', db).map((t) => t.symbol);
    expect(open).toContain('Q');
    expect(open).not.toContain('P');
    db.close();
  });

  it('second rebalance is idempotent (no duplicate inserts)', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    const session = '2026-05-08';
    insertRegimeBull(db, session);
    quote(db, 'ONLY', session, 75);
    sigRank(db, 'ONLY', session, 1);

    const a = runMomentumRebalance({ calendarDate: session, db, skipRanker: true });
    const b = runMomentumRebalance({ calendarDate: session, db, skipRanker: true });
    expect(a.entriesInserted).toBe(1);
    expect(b.entriesInserted).toBe(0);
    expect(getOpenPaperTradesForSignal('momentum_mf', db)).toHaveLength(1);
    db.close();
  });
});
