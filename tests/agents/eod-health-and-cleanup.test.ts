import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectEodHealthSnapshot } from '../../src/agents/eod-evaluate.js';
import { runWeeklyCleanup } from '../../src/agents/weekly-cleanup.js';
import { closeDb, getDb, migrate } from '../../src/db/index.js';

describe('eod-evaluate health SQL', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-eod-health-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = dbPath;
    migrate(getDb({ path: dbPath }));
  });

  afterEach(() => {
    closeDb();
    try {
      rmSync(dbPath);
      rmSync(`${dbPath}-wal`);
      rmSync(`${dbPath}-shm`);
    } catch {
      // best effort cleanup
    }
  });

  it('collectEodHealthSnapshot runs all health queries without SQL errors', () => {
    const db = getDb({ path: dbPath });
    const snap = collectEodHealthSnapshot(db);

    expect(snap.stopRaisesToday.raises).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(snap.tradesClosedToday)).toBe(true);
    expect(Array.isArray(snap.openTradesSummary)).toBe(true);
    expect(Array.isArray(snap.expectancyBySignalType)).toBe(true);
    expect(Array.isArray(snap.tradesNearTimeStop)).toBe(true);
    expect(Array.isArray(snap.signalPerformance30d)).toBe(true);
    expect(Array.isArray(snap.signalPerformance30dDeduped)).toBe(true);
    expect(Array.isArray(snap.openPositions)).toBe(true);
    expect(Array.isArray(snap.openPositionDuplicates)).toBe(true);
    expect(Array.isArray(snap.regimeRecent3)).toBe(true);
    expect(Array.isArray(snap.recentClosures)).toBe(true);
    expect(snap.postFixAiPick).toBeDefined();
    expect(Array.isArray(snap.corporateActions7d)).toBe(true);
    expect(Array.isArray(snap.guardrailHitsToday)).toBe(true);
  });
});

describe('weekly-cleanup', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-weekly-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = dbPath;
    migrate(getDb({ path: dbPath }));
  });

  afterEach(() => {
    closeDb();
    try {
      rmSync(dbPath);
      rmSync(`${dbPath}-wal`);
      rmSync(`${dbPath}-shm`);
    } catch {
      // best effort cleanup
    }
  });

  it('removes signals older than 365 days', async () => {
    const db = getDb({ path: dbPath });
    db.prepare(
      `INSERT INTO signals (symbol, date, name, value, source) VALUES ('TST', '2020-01-01', 'rsi_14', 50, 'technical')`,
    ).run();
    db.prepare(
      `INSERT INTO signals (symbol, date, name, value, source) VALUES ('TST', date('now', 'localtime'), 'rsi_14', 51, 'technical')`,
    ).run();

    await runWeeklyCleanup(db);

    const oldRow = db
      .prepare(`SELECT COUNT(*) AS n FROM signals WHERE symbol = 'TST' AND date = '2020-01-01'`)
      .get() as { n: number };
    const newRow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM signals WHERE symbol = 'TST' AND date = date('now', 'localtime')`,
      )
      .get() as { n: number };

    expect(oldRow.n).toBe(0);
    expect(newRow.n).toBe(1);
  });
});
