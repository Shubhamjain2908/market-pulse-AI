import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, migrate } from '../../src/db/index.js';
import { getQualityGarpFundamentals } from '../../src/db/queries.js';

describe('getQualityGarpFundamentals', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-qg-${Date.now()}-${Math.random()}.db`);
    db = getDb({ path: dbPath });
    migrate(db);
  });

  afterEach(() => {
    db.close();
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(`${dbPath}${suffix}`);
      } catch {
        /* ignore */
      }
    }
  });

  it('live mode requires exact snapshot as_of', () => {
    db.prepare(
      `INSERT INTO fundamentals (symbol, as_of, pe, pb, source)
       VALUES ('AAA', '2024-01-01', 20, 3, 'yahoo_snapshot'),
              ('AAA', '2026-06-06', 22, 3.5, 'yahoo_snapshot')`,
    ).run();
    db.prepare(
      `INSERT INTO fundamentals (symbol, as_of, roe, roce, source)
       VALUES ('AAA', '2023-03-31', 0.2, 0.22, 'yahoo_annual'),
              ('AAA', '2024-03-31', 0.21, 0.23, 'yahoo_annual'),
              ('AAA', '2025-03-31', 0.22, 0.24, 'yahoo_annual')`,
    ).run();

    expect(getQualityGarpFundamentals('2025-06-01', db)).toHaveLength(0);

    const live = getQualityGarpFundamentals('2026-06-06', db);
    expect(live).toHaveLength(1);
    expect(live[0]?.pe).toBe(22);
  });

  it('pointInTime mode picks latest snapshot on or before screen date', () => {
    db.prepare(
      `INSERT INTO fundamentals (symbol, as_of, pe, pb, source)
       VALUES ('AAA', '2024-01-01', 18, 2.5, 'yahoo_snapshot'),
              ('AAA', '2026-06-06', 22, 3.5, 'yahoo_snapshot')`,
    ).run();
    db.prepare(
      `INSERT INTO fundamentals (symbol, as_of, roe, roce, source)
       VALUES ('AAA', '2023-03-31', 0.2, 0.22, 'yahoo_annual'),
              ('AAA', '2024-03-31', 0.21, 0.23, 'yahoo_annual'),
              ('AAA', '2025-03-31', 0.22, 0.24, 'yahoo_annual')`,
    ).run();

    const pit = getQualityGarpFundamentals('2025-06-01', db, { pointInTime: true });
    expect(pit).toHaveLength(1);
    expect(pit[0]?.pe).toBe(18);
    expect(pit[0]?.latestRoce).toBe(0.24);
    expect(pit[0]?.thirdRoe).toBe(0.2);
  });

  it('annual PIT excludes fiscal years after screen date', () => {
    db.prepare(
      `INSERT INTO fundamentals (symbol, as_of, pe, pb, source)
       VALUES ('BBB', '2024-01-01', 15, 2, 'yahoo_snapshot')`,
    ).run();
    db.prepare(
      `INSERT INTO fundamentals (symbol, as_of, roe, roce, source)
       VALUES ('BBB', '2022-03-31', 0.19, 0.21, 'yahoo_annual'),
              ('BBB', '2023-03-31', 0.2, 0.22, 'yahoo_annual'),
              ('BBB', '2024-03-31', 0.21, 0.23, 'yahoo_annual'),
              ('BBB', '2025-03-31', 0.25, 0.28, 'yahoo_annual')`,
    ).run();

    const pit = getQualityGarpFundamentals('2024-06-01', db, { pointInTime: true });
    expect(pit).toHaveLength(1);
    expect(pit[0]?.latestRoe).toBe(0.21);
    expect(pit[0]?.prevRoe).toBe(0.2);
    expect(pit[0]?.thirdRoe).toBe(0.19);
    expect(pit[0]?.latestRoce).toBe(0.23);
  });

  it('annual ranked uses yahoo_annual only, not screener fundamental rows', () => {
    db.prepare(
      `INSERT INTO fundamentals (symbol, as_of, pe, pb, source)
       VALUES ('CCC', '2026-06-06', 20, 3, 'yahoo_snapshot')`,
    ).run();
    db.prepare(
      `INSERT INTO fundamentals (symbol, as_of, roe, roce, source)
       VALUES ('CCC', '2025-03-31', 0.21, 0.24, 'yahoo_annual'),
              ('CCC', '2024-03-31', 0.2, 0.22, 'yahoo_annual'),
              ('CCC', '2023-03-31', 0.19, 0.21, 'yahoo_annual'),
              ('CCC', '2025-03-30', 0.99, 0.99, 'screener')`,
    ).run();

    const row = getQualityGarpFundamentals('2026-06-06', db)[0];
    expect(row?.latestRoe).toBe(0.21);
    expect(row?.latestRoce).toBe(0.24);
  });
});
