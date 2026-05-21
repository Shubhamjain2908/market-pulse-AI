import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initLongTrailState, stepLongPositionOneBar } from '../../src/backtest/position.js';
import { closeDb, getDb, migrate } from '../../src/db/index.js';

describe('stepLongPositionOneBar', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-pos-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = dbPath;
  });

  afterEach(() => {
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(`${dbPath}${suffix}`);
      } catch {
        // best effort
      }
    }
  });

  it('stops out long on gap through stop using bar.open (R3)', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    db.prepare(
      `
      INSERT INTO quotes (symbol, exchange, date, open, high, low, close, adj_close, volume, source)
      VALUES ('AAA', 'NSE', '2026-05-01', 100, 100, 100, 100, 100, 0, 'test'),
             ('AAA', 'NSE', '2026-05-02', 85, 90, 80, 88, 88, 0, 'test')
    `,
    ).run();

    const state = initLongTrailState({
      symbol: 'AAA',
      entryPrice: 100,
      sourceDate: '2026-05-01',
      initialMultiplier: 2,
      initialStopLoss: 92,
      target: 130,
      maxHoldDays: 90,
      atr14AtSourceDate: 2,
    });

    const bar = { date: '2026-05-02', open: 85, high: 90, low: 80, close: 88 };
    const out = stepLongPositionOneBar(state, bar, 2, 2, db, 0);
    expect(out.status).toBe('closed');
    if (out.status === 'closed') {
      expect(out.result.exitGrossPrice).toBe(85);
      // ATR at entry ⇒ initialSetupComplete already true ⇒ first bar uses trail path (skipTrailThisBar false).
      expect(out.result.exitReason).toBe('TRAILING_STOP');
    }
  });

  it('labels first-bar stop-out INITIAL_STOP when day-1 latch runs (no ATR at source)', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    db.prepare(
      `
      INSERT INTO quotes (symbol, exchange, date, open, high, low, close, adj_close, volume, source)
      VALUES ('BBB', 'NSE', '2026-05-01', 100, 100, 100, 100, 100, 0, 'test'),
             ('BBB', 'NSE', '2026-05-02', 85, 90, 80, 88, 88, 0, 'test')
    `,
    ).run();

    const state = initLongTrailState({
      symbol: 'BBB',
      entryPrice: 100,
      sourceDate: '2026-05-01',
      initialMultiplier: 2,
      initialStopLoss: 92,
      target: 130,
      maxHoldDays: 90,
      atr14AtSourceDate: null,
    });

    const bar = { date: '2026-05-02', open: 85, high: 90, low: 80, close: 88 };
    const out = stepLongPositionOneBar(state, bar, 2, 2, db, 0);
    expect(out.status).toBe('closed');
    if (out.status === 'closed') {
      expect(out.result.exitReason).toBe('INITIAL_STOP');
    }
  });
});
