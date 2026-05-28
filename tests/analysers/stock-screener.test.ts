import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runStockScreenAnalyser } from '../../src/analysers/stock-screener.js';
import { loadStrategyGates } from '../../src/config/loaders.js';
import { migrate } from '../../src/db/migrate.js';
import { seedStrategyGates } from '../../src/db/regime-queries.js';

function insertQualityBaseRows(db: DatabaseType, symbol: string, asOf = '2026-05-28'): void {
  db.prepare(
    `
    INSERT INTO fundamentals (symbol, as_of, roe, revenue_growth_yoy, source)
    VALUES (?, '2025-03-31', 0.21, 0.16, 'yahoo_annual'),
           (?, '2024-03-31', 0.19, 0.14, 'yahoo_annual')
  `,
  ).run(symbol, symbol);

  db.prepare(
    `
    INSERT INTO fundamentals (
      symbol, as_of, pe, pb, peg, market_cap,
      source
    ) VALUES (?, ?, 22.4, 3.1, NULL, 1823000000000, 'yahoo_snapshot')
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
    seedStrategyGates(loadStrategyGates({ fresh: true }).rows, db);

    db.prepare(
      `INSERT INTO symbols (symbol, exchange, sector, is_index, is_active) VALUES (?, 'NSE', ?, 0, 1)`,
    ).run('ABC', 'Industrials');
    insertQualityBaseRows(db, 'ABC');

    const result = runStockScreenAnalyser(
      { date: '2026-05-28', symbols: ['ABC'], onlyScreen: 'quality_garp', regime: 'CHOPPY' },
      db,
    );

    expect(result.matchesByScreen.quality_garp).toBe(1);
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
    expect(payload.peg).toBeNull();
    expect(payload.pct_from_sma50).toBeCloseTo(1.2676, 3);
    expect(payload.__regime_meta).toEqual({
      regime: 'CHOPPY',
      sizeMultiplier: 0.75,
      strategyId: 'quality_garp',
    });
  });

  it('excludes symbol when prev_roe is missing', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedStrategyGates(loadStrategyGates({ fresh: true }).rows, db);

    db.prepare(
      `
      INSERT INTO fundamentals (symbol, as_of, roe, revenue_growth_yoy, source)
      VALUES ('ONEYEAR', '2025-03-31', 0.25, 0.2, 'yahoo_annual')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO fundamentals (symbol, as_of, pe, pb, source)
      VALUES ('ONEYEAR', '2026-05-28', 20, 2.5, 'yahoo_snapshot')
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
  });

  it('excludes ETF symbols from config even when fundamentals pass', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedStrategyGates(loadStrategyGates({ fresh: true }).rows, db);

    insertQualityBaseRows(db, 'NIFTYBEES');

    const result = runStockScreenAnalyser(
      { date: '2026-05-28', symbols: ['NIFTYBEES'], onlyScreen: 'quality_garp' },
      db,
    );
    expect(result.matchesByScreen.quality_garp).toBe(0);
  });
});
