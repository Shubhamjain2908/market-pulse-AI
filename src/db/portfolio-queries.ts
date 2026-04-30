/**
 * Portfolio-related prepared queries (Phase 5).
 *
 * Kept in a separate file from queries.ts to avoid that file growing
 * unbounded. Re-exported by db/index.ts so call-sites still see a single
 * surface.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { getDb } from './connection.js';

// -----------------------------------------------------------------------
// Holdings
// -----------------------------------------------------------------------

export interface PortfolioHoldingRow {
  symbol: string;
  exchange: string;
  asOf: string;
  qty: number;
  avgPrice: number;
  lastPrice?: number | null;
  pnl?: number | null;
  pnlPct?: number | null;
  dayChange?: number | null;
  dayChangePct?: number | null;
  product?: string | null;
  source: 'kite' | 'manual';
  raw?: string | null;
}

export function upsertHoldings(rows: PortfolioHoldingRow[], db: DatabaseType = getDb()): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO portfolio_holdings (
      symbol, exchange, as_of, qty, avg_price, last_price, pnl, pnl_pct,
      day_change, day_change_pct, product, source, raw
    ) VALUES (
      @symbol, @exchange, @asOf, @qty, @avgPrice, @lastPrice, @pnl, @pnlPct,
      @dayChange, @dayChangePct, @product, @source, @raw
    )
    ON CONFLICT(symbol, as_of) DO UPDATE SET
      exchange       = excluded.exchange,
      qty            = excluded.qty,
      avg_price      = excluded.avg_price,
      last_price     = excluded.last_price,
      pnl            = excluded.pnl,
      pnl_pct        = excluded.pnl_pct,
      day_change     = excluded.day_change,
      day_change_pct = excluded.day_change_pct,
      product        = excluded.product,
      source         = excluded.source,
      raw            = excluded.raw
  `);
  const tx = db.transaction((batch: PortfolioHoldingRow[]) => {
    for (const r of batch) {
      stmt.run({
        symbol: r.symbol,
        exchange: r.exchange,
        asOf: r.asOf,
        qty: r.qty,
        avgPrice: r.avgPrice,
        lastPrice: r.lastPrice ?? null,
        pnl: r.pnl ?? null,
        pnlPct: r.pnlPct ?? null,
        dayChange: r.dayChange ?? null,
        dayChangePct: r.dayChangePct ?? null,
        product: r.product ?? null,
        source: r.source,
        raw: r.raw ?? null,
      });
    }
  });
  tx(rows);
  return rows.length;
}

export function getLatestHoldings(db: DatabaseType = getDb()): PortfolioHoldingRow[] {
  return db
    .prepare(`
      SELECT symbol, exchange, as_of AS asOf, qty, avg_price AS avgPrice,
             last_price AS lastPrice, pnl, pnl_pct AS pnlPct,
             day_change AS dayChange, day_change_pct AS dayChangePct,
             product, source, raw
      FROM portfolio_holdings
      WHERE as_of = (SELECT MAX(as_of) FROM portfolio_holdings)
      ORDER BY symbol
    `)
    .all() as PortfolioHoldingRow[];
}

// -----------------------------------------------------------------------
// Per-holding analysis (LLM-generated)
// -----------------------------------------------------------------------

export interface PortfolioAnalysisRow {
  symbol: string;
  date: string;
  action: 'HOLD' | 'ADD' | 'TRIM' | 'EXIT';
  conviction: number;
  thesis: string;
  bullPoints: string[];
  bearPoints: string[];
  triggerReason: string;
  suggestedStop?: number | null;
  suggestedTarget?: number | null;
  pnlPct?: number | null;
  model: string;
  raw?: string | null;
}

export function upsertPortfolioAnalysis(
  rows: PortfolioAnalysisRow[],
  db: DatabaseType = getDb(),
): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO portfolio_analysis (
      symbol, date, action, conviction, thesis, bull_points, bear_points,
      trigger_reason, suggested_stop, suggested_target, pnl_pct, model, raw_response
    ) VALUES (
      @symbol, @date, @action, @conviction, @thesis, @bullPoints, @bearPoints,
      @triggerReason, @suggestedStop, @suggestedTarget, @pnlPct, @model, @raw
    )
    ON CONFLICT(symbol, date) DO UPDATE SET
      action           = excluded.action,
      conviction       = excluded.conviction,
      thesis           = excluded.thesis,
      bull_points      = excluded.bull_points,
      bear_points      = excluded.bear_points,
      trigger_reason   = excluded.trigger_reason,
      suggested_stop   = excluded.suggested_stop,
      suggested_target = excluded.suggested_target,
      pnl_pct          = excluded.pnl_pct,
      model            = excluded.model,
      raw_response     = excluded.raw_response
  `);
  const tx = db.transaction((batch: PortfolioAnalysisRow[]) => {
    for (const r of batch) {
      stmt.run({
        symbol: r.symbol,
        date: r.date,
        action: r.action,
        conviction: r.conviction,
        thesis: r.thesis,
        bullPoints: JSON.stringify(r.bullPoints),
        bearPoints: JSON.stringify(r.bearPoints),
        triggerReason: r.triggerReason,
        suggestedStop: r.suggestedStop ?? null,
        suggestedTarget: r.suggestedTarget ?? null,
        pnlPct: r.pnlPct ?? null,
        model: r.model,
        raw: r.raw ?? null,
      });
    }
  });
  tx(rows);
  return rows.length;
}

export function getPortfolioAnalysisForDate(
  date: string,
  db: DatabaseType = getDb(),
): PortfolioAnalysisRow[] {
  const rows = db
    .prepare(`
      SELECT symbol, date, action, conviction, thesis,
             bull_points AS bullPoints, bear_points AS bearPoints,
             trigger_reason AS triggerReason, suggested_stop AS suggestedStop,
             suggested_target AS suggestedTarget, pnl_pct AS pnlPct,
             model, raw_response AS raw
      FROM portfolio_analysis
      WHERE date = ?
      ORDER BY conviction DESC, symbol
    `)
    .all(date) as Array<PortfolioAnalysisRow & { bullPoints: string; bearPoints: string }>;
  return rows.map((r) => ({
    ...r,
    bullPoints: JSON.parse(r.bullPoints) as string[],
    bearPoints: JSON.parse(r.bearPoints) as string[],
  }));
}

// -----------------------------------------------------------------------
// Intraday quotes (mp scan)
// -----------------------------------------------------------------------

export interface IntradayQuoteRow {
  symbol: string;
  capturedAt: string;
  lastPrice: number;
  prevClose?: number | null;
  changePct?: number | null;
  volume?: number | null;
  source: string;
}

export function upsertIntradayQuotes(rows: IntradayQuoteRow[], db: DatabaseType = getDb()): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO intraday_quotes (symbol, captured_at, last_price, prev_close, change_pct, volume, source)
    VALUES (@symbol, @capturedAt, @lastPrice, @prevClose, @changePct, @volume, @source)
    ON CONFLICT(symbol, captured_at) DO UPDATE SET
      last_price = excluded.last_price,
      prev_close = excluded.prev_close,
      change_pct = excluded.change_pct,
      volume     = excluded.volume,
      source     = excluded.source
  `);
  const tx = db.transaction((batch: IntradayQuoteRow[]) => {
    for (const r of batch) {
      stmt.run({
        symbol: r.symbol,
        capturedAt: r.capturedAt,
        lastPrice: r.lastPrice,
        prevClose: r.prevClose ?? null,
        changePct: r.changePct ?? null,
        volume: r.volume ?? null,
        source: r.source,
      });
    }
  });
  tx(rows);
  return rows.length;
}
