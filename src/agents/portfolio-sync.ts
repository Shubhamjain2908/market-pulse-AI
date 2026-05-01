/**
 * Portfolio Sync agent. Pulls today's holdings into the portfolio_holdings
 * table from one of two sources:
 *
 *   PORTFOLIO_SOURCE=kite    → Zerodha Kite Connect (live holdings + LTP)
 *   PORTFOLIO_SOURCE=manual  → config/portfolio.json (static, edit by hand)
 *
 * Either way, the result is a uniform row in portfolio_holdings keyed
 * by (symbol, as_of). Downstream code (portfolio analyser, briefing)
 * never has to care which source produced the row.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { config } from '../config/env.js';
import { loadPortfolio } from '../config/loaders.js';
import { type PortfolioHoldingRow, getDb, upsertHoldings } from '../db/index.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { KiteApiError, KiteClient } from '../ingestors/kite/client.js';
import { child } from '../logger.js';

const log = child({ component: 'portfolio-sync' });

export interface PortfolioSyncResult {
  date: string;
  source: 'kite' | 'manual';
  holdingsCount: number;
  totalValue: number;
  totalPnl: number;
  totalPnlPct: number;
}

export async function runPortfolioSync(opts: { date?: string } = {}): Promise<PortfolioSyncResult> {
  const date = opts.date ?? isoDateIst();
  const source = config.PORTFOLIO_SOURCE;
  const db = getDb();

  let rows: PortfolioHoldingRow[];
  if (source === 'kite') {
    rows = await fetchKiteHoldings(date);
  } else {
    rows = readManualHoldings(date, db);
  }

  upsertHoldings(rows, db);

  const totalValue = rows.reduce((s, r) => s + r.qty * (r.lastPrice ?? r.avgPrice), 0);
  const totalPnl = rows.reduce((s, r) => s + (r.pnl ?? 0), 0);
  const totalCost = rows.reduce((s, r) => s + r.qty * r.avgPrice, 0);
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

  log.info(
    { date, source, holdings: rows.length, totalValue, totalPnl, totalPnlPct },
    'portfolio sync complete',
  );

  return {
    date,
    source,
    holdingsCount: rows.length,
    totalValue,
    totalPnl,
    totalPnlPct,
  };
}

async function fetchKiteHoldings(date: string): Promise<PortfolioHoldingRow[]> {
  if (!config.KITE_ACCESS_TOKEN) {
    throw new Error(
      'PORTFOLIO_SOURCE=kite but KITE_ACCESS_TOKEN is not set. Run `pnpm cli kite-login` first.',
    );
  }
  const client = new KiteClient();
  let holdings: Awaited<ReturnType<KiteClient['getHoldings']>>;
  try {
    holdings = await client.getHoldings();
  } catch (err) {
    if (err instanceof KiteApiError && err.isTokenExpired()) {
      throw new Error(
        'Kite access_token has expired. Refresh with `pnpm cli kite-login` (tokens expire ~6 AM IST daily).',
      );
    }
    throw err;
  }

  return holdings
    .filter((h) => h.quantity > 0)
    .map<PortfolioHoldingRow>((h) => {
      const pnl = h.pnl;
      const pnlPct = h.average_price > 0 ? (h.last_price / h.average_price - 1) * 100 : 0;
      return {
        symbol: h.tradingsymbol,
        exchange: h.exchange,
        asOf: date,
        qty: h.quantity,
        avgPrice: h.average_price,
        lastPrice: h.last_price,
        pnl,
        pnlPct,
        dayChange: h.day_change ?? null,
        dayChangePct: h.day_change_percentage ?? null,
        product: h.product ?? null,
        source: 'kite',
        raw: JSON.stringify(h),
      };
    });
}

function readManualHoldings(date: string, db: DatabaseType): PortfolioHoldingRow[] {
  const portfolio = loadPortfolio();
  return portfolio.holdings.map<PortfolioHoldingRow>((h) => ({
    ...resolveManualPnl(h.symbol.toUpperCase(), h.avgPrice, h.qty, date, db),
    symbol: h.symbol.toUpperCase(),
    exchange: 'NSE',
    asOf: date,
    qty: h.qty,
    avgPrice: h.avgPrice,
    dayChange: null,
    dayChangePct: null,
    product: null,
    source: 'manual',
    raw: null,
  }));
}

function resolveManualPnl(
  symbol: string,
  avgPrice: number,
  qty: number,
  date: string,
  db: DatabaseType,
): Pick<PortfolioHoldingRow, 'lastPrice' | 'pnl' | 'pnlPct'> {
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
  const lastPrice = row?.close ?? null;
  if (lastPrice == null || avgPrice <= 0) {
    return { lastPrice: null, pnl: null, pnlPct: null };
  }
  const pnl = (lastPrice - avgPrice) * qty;
  const pnlPct = (lastPrice / avgPrice - 1) * 100;
  return { lastPrice, pnl, pnlPct };
}
