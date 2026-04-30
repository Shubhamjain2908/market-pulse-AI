/**
 * Watchlist alert generator. Reads the latest signals for each watchlist
 * symbol and emits "alerts" — single-stock, threshold-based notifications
 * (RSI extreme, volume spike, near 52W high/low). Writes to the `alerts`
 * table so we can render alert history and audit which alerts the user
 * acted on.
 *
 * Phase 1 generated these alerts inline inside briefing/composer.ts;
 * Phase 2 promotes them to first-class persisted records, then the
 * briefing reads back from the table.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { loadWatchlist } from '../config/loaders.js';
import { getDb } from '../db/index.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { child } from '../logger.js';
import { DbSignalProvider, type SignalProvider } from './signal-provider.js';

const log = child({ component: 'alerts' });

export type AlertKind =
  | 'rsi_overbought'
  | 'rsi_oversold'
  | 'volume_spike'
  | 'near_52w_high'
  | 'near_52w_low';

export interface Alert {
  symbol: string;
  date: string;
  kind: AlertKind;
  signal: string;
  value: number;
  message: string;
}

interface AlertRule {
  kind: AlertKind;
  signal: string;
  matches: (value: number) => boolean;
  message: (value: number) => string;
}

const ALERT_RULES: AlertRule[] = [
  {
    kind: 'rsi_overbought',
    signal: 'rsi_14',
    matches: (v) => v >= 70,
    message: (v) => `RSI ${v.toFixed(1)} — overbought, watch for pullback`,
  },
  {
    kind: 'rsi_oversold',
    signal: 'rsi_14',
    matches: (v) => v <= 30,
    message: (v) => `RSI ${v.toFixed(1)} — oversold, potential bounce`,
  },
  {
    kind: 'volume_spike',
    signal: 'volume_ratio_20d',
    matches: (v) => v >= 2,
    message: (v) => `Volume ${v.toFixed(2)}× the 20-day average — investigate news`,
  },
  {
    kind: 'near_52w_high',
    signal: 'pct_from_52w_high',
    matches: (v) => v >= -2,
    message: (v) => `${(-v).toFixed(2)}% below 52-week high`,
  },
  {
    kind: 'near_52w_low',
    signal: 'pct_from_52w_low',
    matches: (v) => v <= 5,
    message: (v) => `${v.toFixed(2)}% above 52-week low`,
  },
];

export interface AlertsRunOptions {
  date?: string;
  symbols?: string[];
  provider?: SignalProvider;
  /** Persist to the `alerts` table. Default true. */
  persist?: boolean;
}

export interface AlertsRunResult {
  date: string;
  alerts: Alert[];
}

export function runAlertScan(
  opts: AlertsRunOptions = {},
  db: DatabaseType = getDb(),
): AlertsRunResult {
  const date = opts.date ?? isoDateIst();
  const symbols = (opts.symbols ?? loadWatchlist().symbols).map((s) => s.toUpperCase());
  const provider = opts.provider ?? new DbSignalProvider(db);
  const persist = opts.persist ?? true;

  const alerts: Alert[] = [];
  for (const symbol of symbols) {
    for (const rule of ALERT_RULES) {
      const value = provider.get(symbol, date, rule.signal);
      if (value == null) continue;
      if (!rule.matches(value)) continue;
      alerts.push({
        symbol,
        date,
        kind: rule.kind,
        signal: rule.signal,
        value,
        message: rule.message(value),
      });
    }
  }

  if (persist) upsertAlerts(alerts, db);

  log.info({ date, count: alerts.length }, 'alert scan complete');
  return { date, alerts };
}

export function upsertAlerts(alerts: Alert[], db: DatabaseType = getDb()): number {
  if (alerts.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO alerts (symbol, date, kind, signal, value, message)
    VALUES (@symbol, @date, @kind, @signal, @value, @message)
    ON CONFLICT(symbol, date, kind) DO UPDATE SET
      value   = excluded.value,
      message = excluded.message
  `);
  const tx = db.transaction((rows: Alert[]) => {
    for (const r of rows) stmt.run(r);
  });
  tx(alerts);
  return alerts.length;
}

export function getAlertsForDate(date: string, db: DatabaseType = getDb()): Alert[] {
  return db
    .prepare(`
      SELECT symbol, date, kind, signal, value, message
      FROM alerts WHERE date = ?
      ORDER BY symbol, kind
    `)
    .all(date) as Alert[];
}
