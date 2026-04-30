/**
 * Hand-written, prepared-statement query helpers. Kept thin and explicit -
 * we'd rather grow this file than reach for an ORM.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import type {
  FiiDiiRow,
  Fundamentals,
  NewsItem,
  RawQuote,
  ScreenResult,
  Signal,
} from '../types/domain.js';
import { getDb } from './connection.js';

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export function upsertQuotes(rows: RawQuote[], db: DatabaseType = getDb()): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO quotes (symbol, exchange, date, open, high, low, close, adj_close, volume, source)
    VALUES (@symbol, @exchange, @date, @open, @high, @low, @close, @adjClose, @volume, @source)
    ON CONFLICT(symbol, exchange, date) DO UPDATE SET
      open      = excluded.open,
      high      = excluded.high,
      low       = excluded.low,
      close     = excluded.close,
      adj_close = excluded.adj_close,
      volume    = excluded.volume,
      source    = excluded.source
  `);
  const tx = db.transaction((batch: RawQuote[]) => {
    for (const r of batch) {
      stmt.run({
        symbol: r.symbol,
        exchange: r.exchange,
        date: r.date,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        adjClose: r.adjClose ?? null,
        volume: r.volume,
        source: r.source,
      });
    }
  });
  tx(rows);
  return rows.length;
}

export function getRecentQuotes(
  symbol: string,
  limit = 200,
  db: DatabaseType = getDb(),
): RawQuote[] {
  const rows = db
    .prepare(`
      SELECT symbol, exchange, date, open, high, low, close, adj_close AS adjClose, volume, source
      FROM quotes WHERE symbol = ?
      ORDER BY date DESC LIMIT ?
    `)
    .all(symbol, limit);
  return rows as RawQuote[];
}

// ---------------------------------------------------------------------------
// Fundamentals
// ---------------------------------------------------------------------------

export function upsertFundamentals(rows: Fundamentals[], db: DatabaseType = getDb()): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO fundamentals (
      symbol, as_of, market_cap, pe, pb, peg, roe, roce,
      revenue_growth_yoy, profit_growth_yoy, debt_to_equity,
      promoter_holding_pct, promoter_holding_change_qoq, dividend_yield, source
    ) VALUES (
      @symbol, @asOf, @marketCap, @pe, @pb, @peg, @roe, @roce,
      @revenueGrowthYoY, @profitGrowthYoY, @debtToEquity,
      @promoterHoldingPct, @promoterHoldingChangeQoQ, @dividendYield, @source
    )
    ON CONFLICT(symbol, as_of) DO UPDATE SET
      market_cap                  = excluded.market_cap,
      pe                          = excluded.pe,
      pb                          = excluded.pb,
      peg                         = excluded.peg,
      roe                         = excluded.roe,
      roce                        = excluded.roce,
      revenue_growth_yoy          = excluded.revenue_growth_yoy,
      profit_growth_yoy           = excluded.profit_growth_yoy,
      debt_to_equity              = excluded.debt_to_equity,
      promoter_holding_pct        = excluded.promoter_holding_pct,
      promoter_holding_change_qoq = excluded.promoter_holding_change_qoq,
      dividend_yield              = excluded.dividend_yield,
      source                      = excluded.source
  `);
  const tx = db.transaction((batch: Fundamentals[]) => {
    for (const r of batch) {
      stmt.run({
        symbol: r.symbol,
        asOf: r.asOf,
        marketCap: r.marketCap ?? null,
        pe: r.pe ?? null,
        pb: r.pb ?? null,
        peg: r.peg ?? null,
        roe: r.roe ?? null,
        roce: r.roce ?? null,
        revenueGrowthYoY: r.revenueGrowthYoY ?? null,
        profitGrowthYoY: r.profitGrowthYoY ?? null,
        debtToEquity: r.debtToEquity ?? null,
        promoterHoldingPct: r.promoterHoldingPct ?? null,
        promoterHoldingChangeQoQ: r.promoterHoldingChangeQoQ ?? null,
        dividendYield: r.dividendYield ?? null,
        source: r.source,
      });
    }
  });
  tx(rows);
  return rows.length;
}

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

export function insertNews(rows: NewsItem[], db: DatabaseType = getDb()): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO news (symbol, headline, summary, source, url, published_at, sentiment)
    VALUES (@symbol, @headline, @summary, @source, @url, @publishedAt, @sentiment)
  `);
  const tx = db.transaction((batch: NewsItem[]) => {
    let inserted = 0;
    for (const r of batch) {
      const result = stmt.run({
        symbol: r.symbol ?? null,
        headline: r.headline,
        summary: r.summary ?? null,
        source: r.source,
        url: r.url,
        publishedAt: r.publishedAt,
        sentiment: r.sentiment ?? null,
      });
      if (result.changes > 0) inserted++;
    }
    return inserted;
  });
  return tx(rows);
}

// ---------------------------------------------------------------------------
// FII/DII
// ---------------------------------------------------------------------------

export function upsertFiiDii(rows: FiiDiiRow[], db: DatabaseType = getDb()): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO fii_dii (date, segment, fii_buy, fii_sell, fii_net, dii_buy, dii_sell, dii_net, source)
    VALUES (@date, @segment, @fiiBuy, @fiiSell, @fiiNet, @diiBuy, @diiSell, @diiNet, @source)
    ON CONFLICT(date, segment) DO UPDATE SET
      fii_buy  = excluded.fii_buy,
      fii_sell = excluded.fii_sell,
      fii_net  = excluded.fii_net,
      dii_buy  = excluded.dii_buy,
      dii_sell = excluded.dii_sell,
      dii_net  = excluded.dii_net,
      source   = excluded.source
  `);
  const tx = db.transaction((batch: FiiDiiRow[]) => {
    for (const r of batch) stmt.run(r);
  });
  tx(rows);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export function upsertSignals(rows: Signal[], db: DatabaseType = getDb()): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO signals (symbol, date, name, value, source)
    VALUES (@symbol, @date, @name, @value, @source)
    ON CONFLICT(symbol, date, name) DO UPDATE SET
      value  = excluded.value,
      source = excluded.source
  `);
  const tx = db.transaction((batch: Signal[]) => {
    for (const r of batch) stmt.run(r);
  });
  tx(rows);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Screen results
// ---------------------------------------------------------------------------

export function upsertScreenResults(rows: ScreenResult[], db: DatabaseType = getDb()): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO screens (symbol, date, screen_name, score, matched_criteria)
    VALUES (@symbol, @date, @screenName, @score, @matchedCriteria)
    ON CONFLICT(symbol, date, screen_name) DO UPDATE SET
      score             = excluded.score,
      matched_criteria  = excluded.matched_criteria
  `);
  const tx = db.transaction((batch: ScreenResult[]) => {
    for (const r of batch) {
      stmt.run({
        symbol: r.symbol,
        date: r.date,
        screenName: r.screenName,
        score: r.score,
        matchedCriteria: JSON.stringify(r.matchedCriteria),
      });
    }
  });
  tx(rows);
  return rows.length;
}
