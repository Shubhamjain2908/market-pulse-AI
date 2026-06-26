import type { Database as DatabaseType } from 'better-sqlite3';

export class TechnicalSignalReader {
  private readonly cache = new Map<string, Map<string, number>>();

  constructor(private readonly db: DatabaseType) {}

  get(symbol: string, date: string, signal: string): number | null {
    const row = this.load(symbol, date);
    const v = row.get(signal);
    return v == null ? null : v;
  }

  private load(symbol: string, date: string): Map<string, number> {
    const key = `${symbol}|${date}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const rows = this.db
      .prepare(`
        SELECT name, value FROM signals
        WHERE symbol = ? AND date <= ?
          AND date >= date(?, '-90 days')
          AND date = (SELECT MAX(s2.date) FROM signals s2
                      WHERE s2.symbol = signals.symbol AND s2.date <= ?
                        AND s2.date >= date(?, '-90 days'))
      `)
      .all(symbol, date, date, date, date) as Array<{ name: string; value: number }>;

    const map = new Map<string, number>();
    for (const row of rows) map.set(row.name, row.value);
    this.cache.set(key, map);
    return map;
  }
}
