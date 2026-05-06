import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runTrailingStopPostMortem,
  scheduleTrailingStopPostMortem,
} from '../../src/agents/trailing-stop-postmortem.js';
import { closeDb, getDb, insertPaperTradeIfAbsent, migrate } from '../../src/db/index.js';
import { insertStopLog } from '../../src/db/trailing-stop-queries.js';
import { resetLlmProvider, setLlmProvider } from '../../src/llm/factory.js';
import { MockLlmProvider } from '../../src/llm/providers/mock.js';

describe('trailing stop post-mortem agent', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-pm-${Date.now()}.db`);
    process.env.DATABASE_PATH = dbPath;
    db = getDb({ path: dbPath });
    migrate(db);
    resetLlmProvider();
    setLlmProvider(new MockLlmProvider());

    insertPaperTradeIfAbsent(
      {
        symbol: 'PMTEST',
        signalType: 'AI_PICK',
        sourceDate: '2026-01-02',
        entryPrice: 100,
        stopLoss: 90,
        target: 150,
        timeHorizon: 'medium',
        maxHoldDays: 90,
      },
      db,
    );
    const tradeId = (
      db.prepare('SELECT id FROM paper_trades WHERE symbol = ?').get('PMTEST') as { id: number }
    ).id;

    db.prepare(
      `
      UPDATE paper_trades
      SET status = 'CLOSED_LOSS', outcome_date = '2026-02-10', exit_price = 92,
          pnl_pct = -8, exit_reason = 'TRAILING_STOP', notes = null
      WHERE id = ?
    `,
    ).run(tradeId);

    const logId = insertStopLog(
      {
        tradeId,
        symbol: 'PMTEST',
        logDate: '2026-02-10',
        prevStop: 93,
        newStop: 92,
        stopDelta: -1,
        candidateStop: 91,
        highestClose: 110,
        atr14Today: 4,
        multiplierUsed: 1.5,
        unrealisedPct: 10,
        action: 'STOPPED_OUT',
      },
      db,
    );
    expect(logId).not.toBeNull();
  });

  afterEach(() => {
    db.close();
    closeDb();
    resetLlmProvider();
    try {
      rmSync(dbPath);
    } catch {
      /* best effort */
    }
  });

  it('writes narrative via LLM for STOPPED_OUT log rows', async () => {
    const logId = (db.prepare('SELECT id FROM trailing_stop_log LIMIT 1').get() as { id: number })
      .id;

    await runTrailingStopPostMortem(logId, db);

    const row = db.prepare('SELECT narrative FROM trailing_stop_log WHERE id = ?').get(logId) as {
      narrative: string | null;
    };
    const narrative = row.narrative;
    expect(narrative).toBeTruthy();
    if (!narrative) throw new Error('expected narrative');
    expect(narrative.length).toBeGreaterThan(40);
    expect(narrative).toContain('trailing');
  });

  it('scheduleTrailingStopPostMortem does not throw synchronously', () => {
    const logId = (db.prepare('SELECT id FROM trailing_stop_log LIMIT 1').get() as { id: number })
      .id;
    expect(() => scheduleTrailingStopPostMortem(logId)).not.toThrow();
  });
});
