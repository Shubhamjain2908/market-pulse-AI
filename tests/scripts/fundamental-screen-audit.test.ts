import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadStrategyGates } from '../../src/config/loaders.js';
import { closeDb, getDb, migrate } from '../../src/db/index.js';
import { seedStrategyGates } from '../../src/db/regime-queries.js';
import { runFundamentalScreenAudit } from '../../src/scripts/fundamental-screen-audit.js';

describe('fundamental-screen-audit', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-fund-audit-${Date.now()}-${Math.random()}.db`);
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

  it('reports full-pass counts for quality_at_value when fundamentals are percent-scaled', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    seedStrategyGates(loadStrategyGates().rows, db);
    const date = '2026-06-19';
    db.prepare(
      `INSERT INTO fundamentals (symbol, as_of, roe, profit_growth_yoy, debt_to_equity, pe, source)
       VALUES ('AAA', ?, 0.18, 12, 0.4, 20, 'yahoo_snapshot')`,
    ).run(date);
    db.prepare(
      `INSERT INTO signals (symbol, date, name, value, source) VALUES ('AAA', ?, 'close', 100, 't')`,
    ).run(date);

    const result = runFundamentalScreenAudit({ date, db });
    const qav = result.fundamentals.find((r) => r.screenName === 'quality_at_value');
    expect(qav?.fullPassCount).toBe(1);
  });
});
