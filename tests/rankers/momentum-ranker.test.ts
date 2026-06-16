import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, migrate } from '../../src/db/index.js';
import {
  crossSectionalZ,
  isMomentumFalseFlag,
  quantileSorted,
  runMomentumRanker,
} from '../../src/rankers/momentum-ranker.js';

describe('rankers/momentum-ranker helpers', () => {
  it('quantileSorted interpolates at q=0.75', () => {
    expect(quantileSorted([1, 2, 3, 4], 0.75)).toBeCloseTo(3.25, 10);
  });

  it('crossSectionalZ returns zeros when fewer than two finite values', () => {
    expect(crossSectionalZ([1, null, null])).toEqual([0, 0, 0]);
    expect(crossSectionalZ([null, null])).toEqual([0, 0]);
  });

  it('crossSectionalZ maps missing to neutral 0', () => {
    const z = crossSectionalZ([1, 3, null]);
    expect(z[2]).toBe(0);
    expect(z[0]).toBeLessThan(0);
    expect(z[1]).toBeGreaterThan(0);
  });

  it('isMomentumFalseFlag fires on loss-making TTM despite positive YoY (IDEA-like)', () => {
    expect(
      isMomentumFalseFlag({
        z1: 1.0,
        profitGrowthYoy: 13,
        netProfitTtm: -5000,
        falseFlagZThreshold: 0.674,
        epsThreshold: -5,
      }),
    ).toBe(true);
    expect(
      isMomentumFalseFlag({
        z1: 1.0,
        profitGrowthYoy: 13,
        netProfitTtm: null,
        falseFlagZThreshold: 0.674,
        epsThreshold: -5,
      }),
    ).toBe(false);
  });
});

describe('rankers/momentum-ranker integration', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-mom-rank-${Date.now()}-${Math.random()}.db`);
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

  it('ranks eligible symbols, false_flag when top-quartile z1 ∧ weak EPS, clears stale rows for ineligible', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    const asOf = '2026-05-02';
    const universe = ['AAA', 'BBB', 'CCC', 'DDD', 'NOPE'];

    const insSig = db.prepare(`
      INSERT INTO signals (symbol, date, name, value, source)
      VALUES (?, ?, ?, ?, 'test')
    `);
    const insFund = db.prepare(`
      INSERT INTO fundamentals (
        symbol, as_of, profit_growth_yoy, net_profit_ttm, source
      ) VALUES (?, ?, ?, ?, 'test')
    `);

    const factorRows: Array<[string, number, number, number]> = [
      ['AAA', 0.5, 1, 0],
      ['BBB', 0.2, 1, 0],
      ['CCC', 0.15, 1, 0],
      ['DDD', 0.1, 1, 0],
    ];
    for (const [sym, mom121, rs, bo] of factorRows) {
      insSig.run(sym, asOf, 'mom_12_1_return', mom121);
      insSig.run(sym, asOf, 'mom_relative_strength_ba', rs);
      insSig.run(sym, asOf, 'mom_volume_breakout_flag', bo);
    }

    insFund.run('AAA', asOf, -10, null);
    insFund.run('BBB', asOf, 10, 100);
    insFund.run('CCC', asOf, 10, 100);
    insFund.run('DDD', asOf, 10, 100);

    insSig.run('NOPE', asOf, 'mom_rank', 99);
    insSig.run('NOPE', asOf, 'mom_composite_score', 99);
    insSig.run('NOPE', asOf, 'mom_false_flag', 1);

    const result = runMomentumRanker({ asOf, universe, db });
    expect(result.eligibleCount).toBe(4);
    expect(result.rankClears).toBe(1);

    const rankStmt = db.prepare(
      `SELECT value FROM signals WHERE symbol = ? AND date = ? AND name = 'mom_rank'`,
    );
    expect(rankStmt.get('AAA', asOf)).toEqual({ value: 1 });
    expect(rankStmt.get('DDD', asOf)).toEqual({ value: 4 });

    const ffStmt = db.prepare(
      `SELECT value FROM signals WHERE symbol = ? AND date = ? AND name = 'mom_false_flag'`,
    );
    expect(ffStmt.get('AAA', asOf)).toEqual({ value: 1 });
    expect(ffStmt.get('BBB', asOf)).toEqual({ value: 0 });

    const nopeRank = db
      .prepare(
        `SELECT COUNT(*) AS c FROM signals WHERE symbol = 'NOPE' AND date = ? AND name IN ('mom_rank','mom_composite_score','mom_false_flag')`,
      )
      .get(asOf) as { c: number };
    expect(nopeRank.c).toBe(0);

    db.close();
  });

  it('false_flag when top-quartile z1 and loss-making net_profit_ttm despite positive YoY', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    const asOf = '2026-06-12';
    const universe = ['IDEA', 'BBB', 'CCC', 'DDD'];

    const insSig = db.prepare(`
      INSERT INTO signals (symbol, date, name, value, source)
      VALUES (?, ?, ?, ?, 'test')
    `);
    const insFund = db.prepare(`
      INSERT INTO fundamentals (
        symbol, as_of, profit_growth_yoy, net_profit_ttm, source
      ) VALUES (?, ?, ?, ?, 'test')
    `);

    const factorRows: Array<[string, number, number, number]> = [
      ['IDEA', 0.6, 1, 0],
      ['BBB', 0.2, 1, 0],
      ['CCC', 0.15, 1, 0],
      ['DDD', 0.1, 1, 0],
    ];
    for (const [sym, mom121, rs, bo] of factorRows) {
      insSig.run(sym, asOf, 'mom_12_1_return', mom121);
      insSig.run(sym, asOf, 'mom_relative_strength_ba', rs);
      insSig.run(sym, asOf, 'mom_volume_breakout_flag', bo);
    }

    insFund.run('IDEA', asOf, 13, -8700);
    insFund.run('BBB', asOf, 10, 500);
    insFund.run('CCC', asOf, 10, 500);
    insFund.run('DDD', asOf, 10, 500);

    runMomentumRanker({ asOf, universe, db });

    const ffStmt = db.prepare(
      `SELECT value FROM signals WHERE symbol = ? AND date = ? AND name = 'mom_false_flag'`,
    );
    expect(ffStmt.get('IDEA', asOf)).toEqual({ value: 1 });
    expect(ffStmt.get('BBB', asOf)).toEqual({ value: 0 });

    db.close();
  });
});
