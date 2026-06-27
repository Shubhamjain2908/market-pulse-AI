import type { Database as DatabaseType } from 'better-sqlite3';

const FLOW_SIGNALS = new Set([
  'fii_net',
  'dii_net',
  'fii_net_5d_sum',
  'dii_net_5d_sum',
  'fii_net_streak_days',
  'dii_net_streak_days',
]);

export function isFlowSignal(signal: string): boolean {
  return FLOW_SIGNALS.has(signal);
}

export class FlowSignalReader {
  private readonly cache = new Map<string, Map<string, number>>();

  constructor(private readonly db: DatabaseType) {}

  get(date: string, signal: string): number | null {
    const row = this.load(date);
    const v = row.get(signal);
    return v == null ? null : v;
  }

  private load(date: string): Map<string, number> {
    const cached = this.cache.get(date);
    if (cached) return cached;

    const rows = this.db
      .prepare(`
        SELECT date, fii_net AS fiiNet, dii_net AS diiNet
        FROM fii_dii
        WHERE date <= ? AND segment = 'cash'
        ORDER BY date DESC LIMIT 30
      `)
      .all(date) as Array<{ date: string; fiiNet: number; diiNet: number }>;

    const map = new Map<string, number>();
    if (rows.length > 0) {
      const today = rows[0];
      if (today) {
        map.set('fii_net', today.fiiNet);
        map.set('dii_net', today.diiNet);
      }
      const last5 = rows.slice(0, 5);
      map.set(
        'fii_net_5d_sum',
        last5.reduce((sum, row) => sum + row.fiiNet, 0),
      );
      map.set(
        'dii_net_5d_sum',
        last5.reduce((sum, row) => sum + row.diiNet, 0),
      );
      map.set('fii_net_streak_days', streak(rows.map((row) => row.fiiNet)));
      map.set('dii_net_streak_days', streak(rows.map((row) => row.diiNet)));
    }
    this.cache.set(date, map);
    return map;
  }
}

function streak(values: number[]): number {
  let n = 0;
  for (const v of values) {
    if (v > 0) n++;
    else break;
  }
  return n;
}
