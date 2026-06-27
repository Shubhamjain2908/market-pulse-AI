import type { Database as DatabaseType } from 'better-sqlite3';

const FUNDAMENTAL_COLUMNS = new Set([
  'market_cap',
  'pe',
  'pb',
  'peg',
  'roe',
  'roce',
  'revenue_growth_yoy',
  'profit_growth_yoy',
  'debt_to_equity',
  'promoter_holding_pct',
  'promoter_holding_change_qoq',
  'dividend_yield',
]);

const PERCENT_SCALE_IF_FRACTION = new Set(['roe', 'roce', 'dividend_yield']);

export function isFundamentalSignal(signal: string): boolean {
  return FUNDAMENTAL_COLUMNS.has(signal);
}

export function normalizeFundamentalForScreen(column: string, value: number): number {
  if (!PERCENT_SCALE_IF_FRACTION.has(column)) return value;
  // |v|<1 heuristic; Screener stores e.g. 17.7% as 17.7. Upgrade: tag unit in DB.
  if (Math.abs(value) > 0 && Math.abs(value) < 1) return value * 100;
  return value;
}

export class FundamentalSignalReader {
  private readonly cache = new Map<string, Map<string, number>>();

  constructor(private readonly db: DatabaseType) {}

  get(symbol: string, column: string): number | null {
    const row = this.load(symbol);
    const v = row.get(column);
    return v == null ? null : v;
  }

  private load(symbol: string): Map<string, number> {
    const cached = this.cache.get(symbol);
    if (cached) return cached;

    const row = this.db
      .prepare(`
        SELECT * FROM fundamentals WHERE symbol = ?
        ORDER BY as_of DESC LIMIT 1
      `)
      .get(symbol) as Record<string, unknown> | undefined;

    const map = new Map<string, number>();
    if (row) {
      for (const col of FUNDAMENTAL_COLUMNS) {
        const v = row[col];
        if (typeof v === 'number' && Number.isFinite(v)) {
          map.set(col, normalizeFundamentalForScreen(col, v));
        }
      }
    }
    this.cache.set(symbol, map);
    return map;
  }
}
