import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { resolveQualityGarpSymbols } from '../../src/analysers/quality-garp-universe.js';
import { migrate } from '../../src/db/migrate.js';

function seedAnnual(db: DatabaseType, symbols: string[]): void {
  for (const symbol of symbols) {
    db.prepare(
      `INSERT INTO fundamentals (symbol, as_of, roe, roce, source)
       VALUES (?, '2025-03-31', 0.2, 0.22, 'yahoo_annual')`,
    ).run(symbol);
  }
}

describe('resolveQualityGarpSymbols', () => {
  it('defaults to yahoo_annual universe', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedAnnual(db, ['AAA', 'BBB', 'CCC']);

    const result = resolveQualityGarpSymbols(db);
    expect(result.universeScope).toBe('yahoo_annual');
    expect(result.symbols.sort()).toEqual(['AAA', 'BBB', 'CCC']);
  });

  it('honours explicit override with override scope', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedAnnual(db, ['AAA', 'BBB']);

    const result = resolveQualityGarpSymbols(db, ['xyz']);
    expect(result.universeScope).toBe('override');
    expect(result.symbols).toEqual(['XYZ']);
  });
});
