/**
 * Stop-loss breach detector.
 *
 * Reads configured stop-loss levels from `config/portfolio.json`, compares
 * them with the latest known price (portfolio_holdings.last_price preferred,
 * fallback to latest EOD close from quotes), and writes `stop_loss_breach`
 * alerts for breached symbols.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { type Alert, upsertAlerts } from '../analysers/alerts.js';
import { loadPortfolio } from '../config/loaders.js';
import { getDb, getLatestHoldings } from '../db/index.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { child } from '../logger.js';
import type { Portfolio } from '../types/domain.js';

const log = child({ component: 'stop-loss-detector' });

export interface StopLossResult {
  date: string;
  checked: number;
  breached: number;
  alerts: Alert[];
}

export function detectStopLossBreaches(
  opts: { date?: string; portfolio?: Portfolio } = {},
  db: DatabaseType = getDb(),
): StopLossResult {
  const date = opts.date ?? isoDateIst();
  const portfolio = opts.portfolio ?? loadPortfolio();
  const stopBySymbol = new Map(
    portfolio.holdings
      .filter((h) => h.qty > 0 && h.stopLoss != null && h.stopLoss > 0)
      .map((h) => [h.symbol.toUpperCase(), h.stopLoss as number]),
  );

  if (stopBySymbol.size === 0) {
    return { date, checked: 0, breached: 0, alerts: [] };
  }

  const holdings = getLatestHoldings(db);
  const latestHoldingBySymbol = new Map(holdings.map((h) => [h.symbol.toUpperCase(), h]));

  const alerts: Alert[] = [];
  let checked = 0;
  for (const [symbol, stopLoss] of stopBySymbol) {
    const px = resolveLatestPrice(symbol, date, latestHoldingBySymbol, db);
    if (px == null) continue;
    checked++;
    if (px <= stopLoss) {
      const gapPct = ((px - stopLoss) / stopLoss) * 100;
      alerts.push({
        symbol,
        date,
        kind: 'stop_loss_breach',
        signal: 'stop_loss',
        value: px,
        message: `STOP-LOSS BREACH: ${symbol} at ₹${px.toFixed(2)} vs stop ₹${stopLoss.toFixed(2)} (${gapPct.toFixed(2)}%)`,
      });
    }
  }

  upsertAlerts(alerts, db);
  log.info({ date, checked, breached: alerts.length }, 'stop-loss scan complete');
  return { date, checked, breached: alerts.length, alerts };
}

function resolveLatestPrice(
  symbol: string,
  date: string,
  holdingBySymbol: Map<string, ReturnType<typeof getLatestHoldings>[number]>,
  db: DatabaseType,
): number | null {
  const holding = holdingBySymbol.get(symbol);
  if (holding?.lastPrice != null && holding.lastPrice > 0) return holding.lastPrice;

  const row = db
    .prepare(
      `
      SELECT close
      FROM quotes
      WHERE symbol = ? AND date <= ?
      ORDER BY date DESC
      LIMIT 1
    `,
    )
    .get(symbol, date) as { close?: number } | undefined;
  return row?.close ?? null;
}
