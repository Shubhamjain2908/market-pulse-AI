import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initLongTrailState, stepLongPositionOneBar } from '../../src/backtest/position.js';
import { closeDb, getDb, migrate } from '../../src/db/index.js';

describe('stepLongPositionOneBar Phase 2 lock-in', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-pos2-${Date.now()}-${Math.random()}.db`);
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

  it('sets wasTailWinner when peak gain crosses lockInThresholdPct', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    db.prepare(
      `
      INSERT INTO quotes (symbol, exchange, date, open, high, low, close, adj_close, volume, source)
      VALUES ('CCC', 'NSE', '2026-05-01', 100, 100, 100, 100, 100, 0, 'test'),
             ('CCC', 'NSE', '2026-05-02', 100, 113, 108, 112, 112, 0, 'test'),
             ('CCC', 'NSE', '2026-05-03', 100, 101, 99, 100, 100, 0, 'test')
    `,
    ).run();

    let state = initLongTrailState({
      symbol: 'CCC',
      entryPrice: 100,
      sourceDate: '2026-05-01',
      initialMultiplier: 2.5,
      tightenedMultiplier: 1.25,
      lockInThresholdPct: 12,
      initialStopLoss: 90,
      target: 200,
      maxHoldDays: 90,
      atr14AtSourceDate: 5,
    });

    const bar2 = { date: '2026-05-02', open: 100, high: 113, low: 108, close: 112 };
    const out2 = stepLongPositionOneBar(state, bar2, 5, 1, db, 0);
    expect(out2.status).toBe('open');
    if (out2.status === 'open') {
      expect(out2.state.wasTailWinner).toBe(true);
      state = out2.state;
    }

    const bar3 = { date: '2026-05-03', open: 100, high: 101, low: 99, close: 100 };
    const out3 = stepLongPositionOneBar(state, bar3, 5, 2, db, 0);
    if (out3.status === 'closed') {
      expect(out3.result.wasTailWinner).toBe(true);
    } else if (out3.status === 'open') {
      expect(out3.state.wasTailWinner).toBe(true);
    }
  });
});
