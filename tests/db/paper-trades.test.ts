import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, migrate } from '../../src/db/index.js';
import {
  closePaperTrade,
  getPaperTradeStats,
  insertPaperTradeIfAbsent,
} from '../../src/db/queries.js';

describe('paper_trades stats', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-pt-${Date.now()}.db`);
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

  it('computes win rate and expectancy in rolling window', () => {
    const base = {
      symbol: 'X',
      signalType: 'AI_PICK' as const,
      entryPrice: 100,
      stopLoss: 90,
      target: 120,
      timeHorizon: 'medium' as const,
      maxHoldDays: 90,
    };
    insertPaperTradeIfAbsent({ ...base, sourceDate: '2026-05-01' }, db);
    insertPaperTradeIfAbsent({ ...base, symbol: 'Y', sourceDate: '2026-05-02' }, db);
    insertPaperTradeIfAbsent({ ...base, symbol: 'Z', sourceDate: '2026-05-03' }, db);

    const rows = db.prepare('SELECT id FROM paper_trades ORDER BY id').all() as Array<{
      id: number;
    }>;
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const id0 = rows[0]?.id;
    const id1 = rows[1]?.id;
    const id2 = rows[2]?.id;
    if (id0 == null || id1 == null || id2 == null) throw new Error('expected three ids');
    closePaperTrade(id0, 'CLOSED_WIN', '2026-05-10', 120, 20, db);
    closePaperTrade(id1, 'CLOSED_LOSS', '2026-05-11', 90, -10, db);
    closePaperTrade(id2, 'CLOSED_WIN', '2026-05-12', 120, 20, db);

    const stats = getPaperTradeStats({ days: 30, asOf: '2026-05-15' }, db);
    expect(stats.closedCount).toBe(3);
    expect(stats.minSampleMet).toBe(false);
    expect(stats.winRate).toBeNull();

    insertPaperTradeIfAbsent(
      {
        symbol: 'W',
        signalType: 'AI_PICK',
        sourceDate: '2026-05-04',
        entryPrice: 100,
        stopLoss: 90,
        target: 120,
        timeHorizon: 'medium',
        maxHoldDays: 90,
      },
      db,
    );
    const wId = (
      db.prepare(`SELECT id FROM paper_trades WHERE symbol = 'W'`).get() as { id: number }
    ).id;
    closePaperTrade(wId, 'CLOSED_WIN', '2026-05-13', 120, 20, db);

    const stats2 = getPaperTradeStats({ days: 30, asOf: '2026-05-15' }, db);
    expect(stats2.closedCount).toBe(4);
    expect(stats2.minSampleMet).toBe(false);

    insertPaperTradeIfAbsent(
      {
        symbol: 'V',
        signalType: 'AI_PICK',
        sourceDate: '2026-05-05',
        entryPrice: 100,
        stopLoss: 90,
        target: 120,
        timeHorizon: 'medium',
        maxHoldDays: 90,
      },
      db,
    );
    const vId = (
      db.prepare(`SELECT id FROM paper_trades WHERE symbol = 'V'`).get() as { id: number }
    ).id;
    closePaperTrade(vId, 'CLOSED_LOSS', '2026-05-14', 90, -10, db);

    const stats3 = getPaperTradeStats({ days: 30, asOf: '2026-05-15' }, db);
    expect(stats3.closedCount).toBe(5);
    expect(stats3.minSampleMet).toBe(true);
    expect(stats3.winRate).toBeCloseTo(3 / 5, 6);
    expect(stats3.expectancyPct).toBeCloseTo((20 - 10 + 20 + 20 - 10) / 5, 6);
  });
});
