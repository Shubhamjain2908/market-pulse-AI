import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeDb,
  getAtr14,
  getDb,
  insertPaperTradeIfAbsent,
  insertStopLog,
  migrate,
} from '../../src/db/index.js';

describe('trailing-stop-queries', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-tsq-${Date.now()}.db`);
    process.env.DATABASE_PATH = dbPath;
    db = getDb({ path: dbPath });
    migrate(db);

    insertPaperTradeIfAbsent(
      {
        symbol: 'TST',
        signalType: 'AI_PICK',
        sourceDate: '2026-01-02',
        entryPrice: 500,
        stopLoss: 470,
        target: 600,
        timeHorizon: 'medium',
        maxHoldDays: 90,
      },
      db,
    );
    const tradeId = (db.prepare('SELECT id FROM paper_trades LIMIT 1').get() as { id: number }).id;

    db.prepare(
      `INSERT INTO signals (symbol, date, name, value, source) VALUES ('TST', '2026-01-05', 'atr_14', 99, 'technical')`,
    ).run();

    insertStopLog(
      {
        tradeId,
        symbol: 'TST',
        logDate: '2026-01-10',
        prevStop: 470,
        newStop: 480,
        stopDelta: 10,
        candidateStop: 480,
        highestClose: 500,
        atr14Today: 10,
        multiplierUsed: 2,
        unrealisedPct: 0,
        action: 'RAISED',
      },
      db,
    );
  });

  afterEach(() => {
    db.close();
    closeDb();
    try {
      rmSync(dbPath);
      rmSync(`${dbPath}-wal`);
      rmSync(`${dbPath}-shm`);
    } catch {
      /* best effort */
    }
  });

  it('falls back within 3 calendar days when ref date has no atr_14', () => {
    db.prepare(`DELETE FROM signals WHERE symbol='TST'`).run();
    db.prepare(
      `INSERT INTO signals (symbol, date, name, value, source) VALUES ('TST', '2026-01-04', 'atr_14', 42, 'technical')`,
    ).run();

    expect(getAtr14('TST', '2026-01-06', db)).toBe(42);
  });

  it('insertStopLog ignores duplicate trade_id + log_date + action', () => {
    const tradeId = (db.prepare('SELECT id FROM paper_trades LIMIT 1').get() as { id: number }).id;
    expect(
      insertStopLog(
        {
          tradeId,
          symbol: 'TST',
          logDate: '2026-01-10',
          prevStop: 470,
          newStop: 480,
          stopDelta: 10,
          candidateStop: 480,
          highestClose: 500,
          atr14Today: 10,
          multiplierUsed: 2,
          unrealisedPct: 0,
          action: 'RAISED',
        },
        db,
      ),
    ).toBe(false);
    const rows = db.prepare('SELECT COUNT(*) AS c FROM trailing_stop_log').get() as { c: number };
    expect(rows.c).toBe(1);
  });
});
