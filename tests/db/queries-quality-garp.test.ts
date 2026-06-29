import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, migrate } from '../../src/db/index.js';
import { getQualityGarpFundamentals, getTrailingOpmStdDev } from '../../src/db/queries.js';

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

describe('getTrailingOpmStdDev', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-opm-${Date.now()}-${Math.random()}.db`);
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

  function insertOpmRows(
    symbol: string,
    rows: Array<{ quarterEnd: string; opmPct: number | null }>,
  ): void {
    const stmt = db.prepare(`
      INSERT INTO quarterly_fundamentals (symbol, quarter_end, opm_pct, source)
      VALUES (?, ?, ?, 'screener')
    `);
    for (const r of rows) {
      stmt.run(symbol, r.quarterEnd, r.opmPct);
    }
  }

  it('(a) returns low std-dev for stable OPM series and gate passes', async () => {
    const symbol = 'STABLE';
    insertOpmRows(symbol, [
      { quarterEnd: '2025-03-31', opmPct: 18 },
      { quarterEnd: '2025-06-30', opmPct: 19 },
      { quarterEnd: '2025-09-30', opmPct: 17.5 },
      { quarterEnd: '2025-12-31', opmPct: 18.5 },
    ]);

    const sd = getTrailingOpmStdDev(symbol, '2026-01-01', 4, db);
    expect(sd).not.toBeNull();
    expect(sd!).toBeLessThanOrEqual(5.0);
  });

  it('(b) returns high std-dev for volatile OPM series and gate blocks', async () => {
    const symbol = 'VOLATILE';
    insertOpmRows(symbol, [
      { quarterEnd: '2025-03-31', opmPct: 5 },
      { quarterEnd: '2025-06-30', opmPct: 25 },
      { quarterEnd: '2025-09-30', opmPct: 8 },
      { quarterEnd: '2025-12-31', opmPct: 30 },
    ]);

    const sd = getTrailingOpmStdDev(symbol, '2026-01-01', 4, db);
    expect(sd).not.toBeNull();
    expect(sd!).toBeGreaterThan(5.0);
  });

  it('(c) returns null with only 3 quarters of data', async () => {
    const symbol = 'ONLY3';
    insertOpmRows(symbol, [
      { quarterEnd: '2025-03-31', opmPct: 15 },
      { quarterEnd: '2025-06-30', opmPct: 16 },
      { quarterEnd: '2025-09-30', opmPct: 14 },
    ]);

    const sd = getTrailingOpmStdDev(symbol, '2026-01-01', 4, db);
    expect(sd).toBeNull();
  });

  it('(d) returns null with zero OPM data (all null opm_pct)', async () => {
    const symbol = 'NULLOPM';
    // Insert rows with null OPM
    db.prepare(
      `INSERT INTO quarterly_fundamentals (symbol, quarter_end, opm_pct, source)
       VALUES (?, ?, NULL, 'screener')`,
    ).run(symbol, '2025-03-31');
    db.prepare(
      `INSERT INTO quarterly_fundamentals (symbol, quarter_end, opm_pct, source)
       VALUES (?, ?, NULL, 'screener')`,
    ).run(symbol, '2025-06-30');

    const sd = getTrailingOpmStdDev(symbol, '2026-01-01', 4, db);
    expect(sd).toBeNull();
  });

  it('(e) PIT: asOf bounds the trailing window correctly', async () => {
    const symbol = 'PITBOUND';
    insertOpmRows(symbol, [
      { quarterEnd: '2024-12-31', opmPct: 15 },
      { quarterEnd: '2025-03-31', opmPct: 16 },
      { quarterEnd: '2025-06-30', opmPct: 17 },
      { quarterEnd: '2025-09-30', opmPct: 18 },
      { quarterEnd: '2025-12-31', opmPct: 19 },
      { quarterEnd: '2026-03-31', opmPct: 20 },
    ]);

    // asOf = 2025-10-15 should only see 4 quarters (2025-09-30 down to 2024-12-31)
    const sd = getTrailingOpmStdDev(symbol, '2025-10-15', 4, db);
    expect(sd).not.toBeNull();
    // The 4 quarters visible: 15, 16, 17, 18 → mean 16.5
    // variance = ((15-16.5)^2 + (16-16.5)^2 + (17-16.5)^2 + (18-16.5)^2) / 4
    //          = (2.25 + 0.25 + 0.25 + 2.25) / 4 = 5/4 = 1.25
    // sd = sqrt(1.25) ≈ 1.118
    expect(sd!).toBeCloseTo(1.118, 2);
  });

  it('(f) boundary: std-dev exactly 5.0 passes gate (> not >=)', async () => {
    const symbol = 'BOUNDARY';
    // [10, 20, 10, 20] → mean=15, variance=(25+25+25+25)/4=25, sd=5.0
    insertOpmRows(symbol, [
      { quarterEnd: '2025-03-31', opmPct: 10 },
      { quarterEnd: '2025-06-30', opmPct: 20 },
      { quarterEnd: '2025-09-30', opmPct: 10 },
      { quarterEnd: '2025-12-31', opmPct: 20 },
    ]);

    const sd = getTrailingOpmStdDev(symbol, '2026-01-01', 4, db);
    expect(sd).not.toBeNull();
    expect(sd!).toBeCloseTo(5.0, 5);
    // Gate uses strict >, so exactly 5.0 should pass
    expect(sd! > 5.0).toBe(false);
  });
});
