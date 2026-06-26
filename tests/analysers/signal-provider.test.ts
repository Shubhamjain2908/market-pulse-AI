import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  DbSignalProvider,
  normalizeFundamentalForScreen,
} from '../../src/analysers/signal-provider.js';
import { migrate } from '../../src/db/migrate.js';

describe('normalizeFundamentalForScreen', () => {
  it('scales Yahoo-style decimal ROE/dividend to percent for screen DSL', () => {
    expect(normalizeFundamentalForScreen('roe', 0.17743)).toBeCloseTo(17.743, 3);
    expect(normalizeFundamentalForScreen('dividend_yield', 0.0201)).toBeCloseTo(2.01, 3);
    expect(normalizeFundamentalForScreen('roe', 17.7)).toBe(17.7);
    expect(normalizeFundamentalForScreen('pe', 22)).toBe(22);
  });

  it('reads source signals with their existing freshness rules', () => {
    const db = new Database(':memory:');
    migrate(db);
    const provider = new DbSignalProvider(db);

    db.prepare(
      `INSERT INTO signals (symbol, date, name, value, source)
       VALUES
         ('AAA', '2026-02-01', 'rsi_14', 99, 'technical'),
         ('AAA', '2026-05-25', 'sma_50', 123, 'technical')`,
    ).run();
    db.prepare(
      `INSERT INTO fundamentals (symbol, as_of, roe, pe, source)
       VALUES ('AAA', '2026-03-31', 0.18, 22, 'yahoo_snapshot')`,
    ).run();
    db.prepare(
      `INSERT INTO fii_dii (date, segment, fii_buy, fii_sell, fii_net, dii_buy, dii_sell, dii_net, source)
       VALUES
         ('2026-05-28', 'cash', 0, 0, 10, 0, 0, 1, 'test'),
         ('2026-05-27', 'cash', 0, 0, 20, 0, 0, 2, 'test'),
         ('2026-05-26', 'fno', 0, 0, 999, 0, 0, 999, 'test'),
         ('2026-05-26', 'cash', 0, 0, -5, 0, 0, 3, 'test')`,
    ).run();

    expect(provider.get('AAA', '2026-05-28', 'rsi_14')).toBeNull();
    expect(provider.get('AAA', '2026-05-28', 'sma_50')).toBe(123);
    expect(provider.get('AAA', '2026-05-28', 'roe')).toBe(18);
    expect(provider.get('AAA', '2026-05-28', 'fii_net_5d_sum')).toBe(25);
    expect(provider.get('AAA', '2026-05-28', 'fii_net_streak_days')).toBe(2);

    db.close();
  });
});
