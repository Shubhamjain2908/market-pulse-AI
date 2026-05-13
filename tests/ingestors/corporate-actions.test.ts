import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, migrate } from '../../src/db/index.js';
import { insertPaperTradeIfAbsent } from '../../src/db/queries.js';
import { applyCorporateActionsFromYahooSplits } from '../../src/ingestors/corporate-actions.js';

describe('ingestors/corporate-actions', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-ca-${Date.now()}.db`);
    process.env.DATABASE_PATH = dbPath;
  });

  afterEach(() => {
    closeDb();
    try {
      rmSync(dbPath);
    } catch {
      /* best effort */
    }
  });

  it('inserts corporate_actions, scales OPEN notionals, appends SPLIT notes once', async () => {
    const db = getDb({ path: dbPath });
    migrate(db);

    insertPaperTradeIfAbsent(
      {
        symbol: 'SPLT',
        signalType: 'AI_PICK',
        sourceDate: '2026-05-01',
        entryPrice: 300,
        stopLoss: 270,
        target: 360,
        timeHorizon: 'medium',
        maxHoldDays: 90,
      },
      db,
    );
    const tradeId = (
      db.prepare('SELECT id FROM paper_trades WHERE symbol = ?').get('SPLT') as {
        id: number;
      }
    ).id;

    db.prepare(
      `
      INSERT INTO trailing_stop_log (
        trade_id, symbol, log_date, prev_stop, new_stop, stop_delta, candidate_stop,
        highest_close, atr14_today, multiplier_used, unrealised_pct, action
      ) VALUES (?, 'SPLT', '2026-05-02', 270, 270, 0, 270, 300, 3, 2, 0, 'HELD')
    `,
    ).run(tradeId);

    const refDate = '2026-05-10';
    const exMs = new Date('2026-05-08T12:00:00+05:30').getTime();

    const fetchSplitHistory = async () => [{ date: exMs, numerator: 3, denominator: 1 }];

    const r1 = await applyCorporateActionsFromYahooSplits(db, { refDate, fetchSplitHistory });
    expect(r1.splitsApplied).toBe(1);

    const pt = db
      .prepare('SELECT entry_price, stop_loss, target FROM paper_trades WHERE id = ?')
      .get(tradeId) as { entry_price: number; stop_loss: number; target: number };
    expect(pt.entry_price).toBe(100);
    expect(pt.stop_loss).toBe(90);
    expect(pt.target).toBe(120);

    const notes = (
      db.prepare('SELECT notes FROM trailing_stop_log WHERE trade_id = ?').get(tradeId) as {
        notes: string | null;
      }
    ).notes;
    expect(notes).toContain('SPLIT 3:1 effective');
    expect(notes).toContain('Pre-split nominal values retained for audit');

    const r2 = await applyCorporateActionsFromYahooSplits(db, { refDate, fetchSplitHistory });
    expect(r2.splitsApplied).toBe(0);

    const pt2 = db.prepare('SELECT entry_price FROM paper_trades WHERE id = ?').get(tradeId) as {
      entry_price: number;
    };
    expect(pt2.entry_price).toBe(100);

    db.close();
  });
});
