import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { OPM_STD_DEV_MAX_PCT } from '../../src/analysers/quality-garp.js';
import { runStockScreenAnalyser } from '../../src/analysers/stock-screener.js';
import { loadStrategyGates } from '../../src/config/loaders.js';
import { migrate } from '../../src/db/migrate.js';
import { seedStrategyGates } from '../../src/db/regime-queries.js';

function insertQualityBaseRows(db: DatabaseType, symbol: string, asOf = '2026-05-28'): void {
  db.prepare(
    `
    INSERT INTO fundamentals (symbol, as_of, roe, roce, revenue_growth_yoy, source)
    VALUES (?, '2025-03-31', 0.21, 0.24, 0.16, 'yahoo_annual'),
           (?, '2024-03-31', 0.19, 0.22, 0.14, 'yahoo_annual'),
           (?, '2023-03-31', 0.2, 0.21, 0.12, 'yahoo_annual')
  `,
  ).run(symbol, symbol, symbol);

  db.prepare(
    `
    INSERT INTO fundamentals (
      symbol, as_of, pe, pb, peg, debt_to_equity, market_cap,
      source
    ) VALUES (?, ?, 22.4, 3.1, 0.95, 0.12, 1823000000000, 'yahoo_snapshot')
  `,
  ).run(symbol, asOf);

  db.prepare(
    `
    INSERT INTO fundamentals (
      symbol, as_of, promoter_holding_pct, promoter_holding_change_qoq, source
    ) VALUES (?, ?, 67.3, 0.1, 'nse_shareholding')
  `,
  ).run(symbol, '2026-05-27');

  db.prepare(
    `
    INSERT INTO signals (symbol, date, name, value, source)
    VALUES
      (?, ?, 'rsi_14', 41.2, 'technical'),
      (?, ?, 'sma_50', 1420.0, 'technical'),
      (?, ?, 'close', 1438.0, 'technical')
  `,
  ).run(symbol, asOf, symbol, asOf, symbol, asOf);
}

describe('stock screener analyser: quality_garp', () => {
  it('persists quality_garp with matched value payload and regime meta', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedStrategyGates(loadStrategyGates().rows, db);

    db.prepare(
      `INSERT INTO symbols (symbol, exchange, sector, is_index, is_active) VALUES (?, 'NSE', ?, 0, 1)`,
    ).run('ABC', 'Industrials');
    insertQualityBaseRows(db, 'ABC');

    const result = runStockScreenAnalyser(
      { date: '2026-05-28', symbols: ['ABC'], onlyScreen: 'quality_garp', regime: 'CHOPPY' },
      db,
    );

    expect(result.matchesByScreen.quality_garp).toBe(1);
    expect(result.funnelByScreen?.quality_garp?.passed).toBe(1);
    const row = db
      .prepare(
        `SELECT score, matched_criteria AS matchedCriteria FROM screens
         WHERE symbol = 'ABC' AND date = '2026-05-28' AND screen_name = 'quality_garp'`,
      )
      .get() as { score: number; matchedCriteria: string } | undefined;

    expect(row).toBeTruthy();
    expect(row?.score).toBe(1);
    const payload = JSON.parse(row?.matchedCriteria ?? '{}') as Record<string, unknown>;
    expect(payload.latest_roe).toBe(0.21);
    expect(payload.prev_roe).toBe(0.19);
    expect(payload.third_roe).toBe(0.2);
    expect(payload.latest_roce).toBe(0.24);
    expect(payload.debt_to_equity).toBe(0.12);
    expect(payload.peg).toBe(0.95);
    expect(payload.pct_from_sma50).toBeCloseTo(1.2676, 3);
    expect(payload.__regime_meta).toEqual({
      regime: 'CHOPPY',
      sizeMultiplier: 0.75,
      strategyId: 'quality_garp',
    });
  });

  it('excludes symbol when third_roe is missing', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedStrategyGates(loadStrategyGates().rows, db);

    db.prepare(
      `
      INSERT INTO fundamentals (symbol, as_of, roe, roce, revenue_growth_yoy, source)
      VALUES ('ONEYEAR', '2025-03-31', 0.25, 0.22, 0.2, 'yahoo_annual'),
             ('ONEYEAR', '2024-03-31', 0.24, 0.21, 0.18, 'yahoo_annual')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO fundamentals (symbol, as_of, pe, pb, peg, debt_to_equity, source)
      VALUES ('ONEYEAR', '2026-05-28', 20, 2.5, 0.9, 0.1, 'yahoo_snapshot')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO signals (symbol, date, name, value, source)
      VALUES
        ('ONEYEAR', '2026-05-28', 'rsi_14', 40, 'technical'),
        ('ONEYEAR', '2026-05-28', 'sma_50', 100, 'technical'),
        ('ONEYEAR', '2026-05-28', 'close', 102, 'technical')
    `,
    ).run();

    const result = runStockScreenAnalyser(
      { date: '2026-05-28', symbols: ['ONEYEAR'], onlyScreen: 'quality_garp' },
      db,
    );
    expect(result.matchesByScreen.quality_garp).toBe(0);
    expect(result.funnelByScreen?.quality_garp?.roe_3yr).toBe(1);
  });

  it('excludes ETF symbols from config even when fundamentals pass', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedStrategyGates(loadStrategyGates().rows, db);

    insertQualityBaseRows(db, 'NIFTYBEES');

    const result = runStockScreenAnalyser(
      { date: '2026-05-28', symbols: ['NIFTYBEES'], onlyScreen: 'quality_garp' },
      db,
    );
    expect(result.matchesByScreen.quality_garp).toBe(0);
    expect(result.funnelByScreen?.quality_garp?.etf_exclusion).toBe(1);
  });

  it('uses the yahoo_annual universe for live quality_garp when symbols are not overridden', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedStrategyGates(loadStrategyGates().rows, db);

    insertQualityBaseRows(db, 'NOTWATCH');

    const result = runStockScreenAnalyser({ date: '2026-05-28', onlyScreen: 'quality_garp' }, db);

    expect(result.matchesByScreen.quality_garp).toBe(1);
    expect(result.funnelByScreen?.quality_garp?.universe).toBe(1);
  });

  it('passes through OPM gate when OPM data is absent (fail-open)', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedStrategyGates(loadStrategyGates().rows, db);

    db.prepare(
      `INSERT INTO symbols (symbol, exchange, sector, is_index, is_active) VALUES (?, 'NSE', ?, 0, 1)`,
    ).run('NOOPM', 'Technology');
    insertQualityBaseRows(db, 'NOOPM');
    // No quarterly_fundamentals rows → OPM gate should be skipped (fail-open)

    const result = runStockScreenAnalyser(
      { date: '2026-05-28', symbols: ['NOOPM'], onlyScreen: 'quality_garp' },
      db,
    );
    expect(result.matchesByScreen.quality_garp).toBe(1);
    expect(result.funnelByScreen?.quality_garp?.passed).toBe(1);

    const row = db
      .prepare(
        `SELECT matched_criteria AS matchedCriteria FROM screens
         WHERE symbol = 'NOOPM' AND date = '2026-05-28' AND screen_name = 'quality_garp'`,
      )
      .get() as { matchedCriteria: string } | undefined;
    expect(row).toBeTruthy();
    const payload = JSON.parse(row!.matchedCriteria) as Record<string, unknown>;
    expect(payload).toHaveProperty('opm_std_dev');
    expect(payload.opm_std_dev).toBeNull();
  });

  it('blocks symbol with volatile OPM (std-dev > 5%)', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedStrategyGates(loadStrategyGates().rows, db);

    db.prepare(
      `INSERT INTO symbols (symbol, exchange, sector, is_index, is_active) VALUES (?, 'NSE', ?, 0, 1)`,
    ).run('VOLOPM', 'Technology');
    insertQualityBaseRows(db, 'VOLOPM');

    // Insert 4 quarters of volatile OPM data
    const insOpm = db.prepare(
      `INSERT INTO quarterly_fundamentals (symbol, quarter_end, opm_pct, source) VALUES (?, ?, ?, 'screener')`,
    );
    insOpm.run('VOLOPM', '2025-03-31', 5);
    insOpm.run('VOLOPM', '2025-06-30', 25);
    insOpm.run('VOLOPM', '2025-09-30', 8);
    insOpm.run('VOLOPM', '2025-12-31', 30);

    const result = runStockScreenAnalyser(
      { date: '2026-05-28', symbols: ['VOLOPM'], onlyScreen: 'quality_garp' },
      db,
    );
    expect(result.matchesByScreen.quality_garp).toBe(0);
    expect(result.funnelByScreen?.quality_garp?.opm_stability).toBe(1);
  });

  it('passes symbol with stable OPM data', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedStrategyGates(loadStrategyGates().rows, db);

    db.prepare(
      `INSERT INTO symbols (symbol, exchange, sector, is_index, is_active) VALUES (?, 'NSE', ?, 0, 1)`,
    ).run('STABLEOPM', 'Technology');
    insertQualityBaseRows(db, 'STABLEOPM');

    // Insert 4 quarters of stable OPM data
    const insOpm = db.prepare(
      `INSERT INTO quarterly_fundamentals (symbol, quarter_end, opm_pct, source) VALUES (?, ?, ?, 'screener')`,
    );
    insOpm.run('STABLEOPM', '2025-03-31', 18);
    insOpm.run('STABLEOPM', '2025-06-30', 19);
    insOpm.run('STABLEOPM', '2025-09-30', 17.5);
    insOpm.run('STABLEOPM', '2025-12-31', 18.5);

    const result = runStockScreenAnalyser(
      { date: '2026-05-28', symbols: ['STABLEOPM'], onlyScreen: 'quality_garp' },
      db,
    );
    expect(result.matchesByScreen.quality_garp).toBe(1);
    expect(result.funnelByScreen?.quality_garp?.passed).toBe(1);

    const row = db
      .prepare(
        `SELECT matched_criteria AS matchedCriteria FROM screens
         WHERE symbol = 'STABLEOPM' AND date = '2026-05-28' AND screen_name = 'quality_garp'`,
      )
      .get() as { matchedCriteria: string } | undefined;
    expect(row).toBeTruthy();
    const payload = JSON.parse(row!.matchedCriteria) as Record<string, unknown>;
    expect(payload.opm_std_dev).not.toBeNull();
    expect(payload.opm_std_dev as number).toBeLessThanOrEqual(OPM_STD_DEV_MAX_PCT);
  });
});
