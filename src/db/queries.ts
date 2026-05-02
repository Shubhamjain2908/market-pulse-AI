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
  Thesis,
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

// ---------------------------------------------------------------------------
// Theses (AI-generated)
// ---------------------------------------------------------------------------

export interface UpsertThesisRow extends Thesis {
  date: string;
  model: string;
  raw?: string;
}

export function upsertThesis(row: UpsertThesisRow, db: DatabaseType = getDb()): void {
  db.prepare(`
    INSERT INTO theses (
      symbol, date, thesis, bull_case, bear_case, entry_zone, stop_loss,
      target, time_horizon, confidence, trigger_reason, model, raw_response
    ) VALUES (
      @symbol, @date, @thesis, @bullCase, @bearCase, @entryZone, @stopLoss,
      @target, @timeHorizon, @confidence, @triggerReason, @model, @raw
    )
    ON CONFLICT(symbol, date) DO UPDATE SET
      thesis         = excluded.thesis,
      bull_case      = excluded.bull_case,
      bear_case      = excluded.bear_case,
      entry_zone     = excluded.entry_zone,
      stop_loss      = excluded.stop_loss,
      target         = excluded.target,
      time_horizon   = excluded.time_horizon,
      confidence     = excluded.confidence,
      trigger_reason = excluded.trigger_reason,
      model          = excluded.model,
      raw_response   = excluded.raw_response
  `).run({
    symbol: row.symbol,
    date: row.date ?? new Date().toISOString().slice(0, 10),
    thesis: row.thesis,
    bullCase: JSON.stringify(row.bullCase),
    bearCase: JSON.stringify(row.bearCase),
    entryZone: row.entryZone,
    stopLoss: row.stopLoss,
    target: row.target,
    timeHorizon: row.timeHorizon,
    confidence: row.confidenceScore,
    triggerReason: row.triggerScreen,
    model: row.model,
    raw: row.raw ?? null,
  });
}

export interface StoredThesis {
  symbol: string;
  date: string;
  thesis: string;
  bullCase: string[];
  bearCase: string[];
  entryZone: string;
  stopLoss: string;
  target: string;
  timeHorizon: string;
  confidence: number;
  triggerReason: string;
  model: string;
}

export function getThesesForDate(date: string, db: DatabaseType = getDb()): StoredThesis[] {
  const rows = db
    .prepare(`
      SELECT symbol, date, thesis, bull_case, bear_case, entry_zone, stop_loss,
             target, time_horizon, confidence, trigger_reason, model
      FROM theses
      WHERE date = ?
      ORDER BY confidence DESC
    `)
    .all(date) as Array<{
    symbol: string;
    date: string;
    thesis: string;
    bull_case: string;
    bear_case: string;
    entry_zone: string;
    stop_loss: string;
    target: string;
    time_horizon: string;
    confidence: number;
    trigger_reason: string;
    model: string;
  }>;

  return rows.map((r) => ({
    symbol: r.symbol,
    date: r.date,
    thesis: r.thesis,
    bullCase: JSON.parse(r.bull_case) as string[],
    bearCase: JSON.parse(r.bear_case) as string[],
    entryZone: r.entry_zone,
    stopLoss: r.stop_loss,
    target: r.target,
    timeHorizon: r.time_horizon,
    confidence: r.confidence,
    triggerReason: r.trigger_reason,
    model: r.model,
  }));
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

// ---------------------------------------------------------------------------
// Symbol metadata (Yahoo sector / industry cache for briefing rollups)
// ---------------------------------------------------------------------------

export interface SymbolMetadataRow {
  symbol: string;
  sector?: string | null;
  industry?: string | null;
  name?: string | null;
}

/** Returns trimmed Yahoo-backed sectors for the given symbols (when present in DB). */
export function getSymbolSectors(
  symbols: string[],
  db: DatabaseType = getDb(),
): Map<string, string> {
  const uniq = [...new Set(symbols.map((s) => s.toUpperCase()))];
  if (uniq.length === 0) return new Map();

  const placeholders = uniq.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT symbol, sector FROM symbols
       WHERE symbol IN (${placeholders})
         AND sector IS NOT NULL AND TRIM(sector) != ''`,
    )
    .all(...uniq) as Array<{ symbol: string; sector: string }>;

  const m = new Map<string, string>();
  for (const r of rows) {
    m.set(r.symbol.toUpperCase(), r.sector.trim());
  }
  return m;
}

export function upsertSymbolMetadata(
  rows: SymbolMetadataRow[],
  db: DatabaseType = getDb(),
): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO symbols (symbol, exchange, sector, industry, name, is_index, is_active)
    VALUES (@symbol, 'NSE', @sector, @industry, @name, 0, 1)
    ON CONFLICT(symbol) DO UPDATE SET
      sector   = COALESCE(excluded.sector, symbols.sector),
      industry = COALESCE(excluded.industry, symbols.industry),
      name     = COALESCE(excluded.name, symbols.name)
  `);
  const tx = db.transaction((batch: SymbolMetadataRow[]) => {
    for (const r of batch) {
      stmt.run({
        symbol: r.symbol.toUpperCase(),
        sector: r.sector ?? null,
        industry: r.industry ?? null,
        name: r.name ?? null,
      });
    }
  });
  tx(rows);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Paper trades (forward-testing ledger)
// ---------------------------------------------------------------------------

export type PaperTradeSignalType = 'AI_PICK' | 'PORTFOLIO_ADD';
export type PaperTradeStatus = 'OPEN' | 'CLOSED_WIN' | 'CLOSED_LOSS' | 'CLOSED_TIME';
export type PaperTradeHorizon = 'short' | 'medium' | 'long';

export interface PaperTradeInsertRow {
  symbol: string;
  signalType: PaperTradeSignalType;
  sourceDate: string;
  entryPrice: number;
  stopLoss: number;
  target: number;
  timeHorizon: PaperTradeHorizon;
  maxHoldDays: number;
}

export interface PaperTradeRow {
  id: number;
  symbol: string;
  signalType: PaperTradeSignalType;
  sourceDate: string;
  entryPrice: number;
  stopLoss: number;
  target: number;
  timeHorizon: PaperTradeHorizon;
  maxHoldDays: number;
  status: PaperTradeStatus;
  outcomeDate: string | null;
  exitPrice: number | null;
  pnlPct: number | null;
  notes: string | null;
  createdAt: string;
}

/** Insert if no row exists for (symbol, signal_type, source_date). Returns true when inserted. */
export function insertPaperTradeIfAbsent(
  row: PaperTradeInsertRow,
  db: DatabaseType = getDb(),
): boolean {
  const result = db
    .prepare(`
    INSERT OR IGNORE INTO paper_trades (
      symbol, signal_type, source_date, entry_price, stop_loss, target,
      time_horizon, max_hold_days, status
    ) VALUES (
      @symbol, @signalType, @sourceDate, @entryPrice, @stopLoss, @target,
      @timeHorizon, @maxHoldDays, 'OPEN'
    )
  `)
    .run({
      symbol: row.symbol.toUpperCase(),
      signalType: row.signalType,
      sourceDate: row.sourceDate,
      entryPrice: row.entryPrice,
      stopLoss: row.stopLoss,
      target: row.target,
      timeHorizon: row.timeHorizon,
      maxHoldDays: row.maxHoldDays,
    });
  return result.changes > 0;
}

export function getOpenPaperTrades(db: DatabaseType = getDb()): PaperTradeRow[] {
  const rows = db
    .prepare(
      `
    SELECT id, symbol, signal_type AS signalType, source_date AS sourceDate,
           entry_price AS entryPrice, stop_loss AS stopLoss, target,
           time_horizon AS timeHorizon, max_hold_days AS maxHoldDays,
           status, outcome_date AS outcomeDate, exit_price AS exitPrice,
           pnl_pct AS pnlPct, notes, created_at AS createdAt
    FROM paper_trades
    WHERE status = 'OPEN'
    ORDER BY source_date ASC, id ASC
  `,
    )
    .all() as Array<{
    id: number;
    symbol: string;
    signalType: PaperTradeSignalType;
    sourceDate: string;
    entryPrice: number;
    stopLoss: number;
    target: number;
    timeHorizon: PaperTradeHorizon;
    maxHoldDays: number;
    status: PaperTradeStatus;
    outcomeDate: string | null;
    exitPrice: number | null;
    pnlPct: number | null;
    notes: string | null;
    createdAt: string;
  }>;

  return rows;
}

export function closePaperTrade(
  id: number,
  status: Exclude<PaperTradeStatus, 'OPEN'>,
  outcomeDate: string,
  exitPrice: number,
  pnlPct: number,
  db: DatabaseType = getDb(),
  notes?: string | null,
): void {
  db.prepare(`
    UPDATE paper_trades
    SET status = @status,
        outcome_date = @outcomeDate,
        exit_price = @exitPrice,
        pnl_pct = @pnlPct,
        notes = COALESCE(@notes, notes)
    WHERE id = @id AND status = 'OPEN'
  `).run({
    id,
    status,
    outcomeDate,
    exitPrice,
    pnlPct,
    notes: notes ?? null,
  });
}

export interface PaperTradeStats {
  windowDays: number;
  asOf: string;
  closedCount: number;
  openCount: number;
  winCount: number;
  lossCount: number;
  timeCount: number;
  winRate: number | null;
  avgWinnerPct: number | null;
  avgLoserPct: number | null;
  expectancyPct: number | null;
  minSampleMet: boolean;
}

const MIN_SAMPLE_CLOSED = 5;

/** Stats for closed trades with outcome_date in [asOf - windowDays, asOf]; openCount is all OPEN rows. */
export function getPaperTradeStats(
  opts: { days: number; asOf: string },
  db: DatabaseType = getDb(),
): PaperTradeStats {
  const { days, asOf } = opts;
  const windowStart = db.prepare('SELECT date(?, ?) AS d').get(asOf, `-${days} days`) as {
    d: string;
  };

  const closedRows = db
    .prepare(
      `
    SELECT status, pnl_pct AS pnlPct
    FROM paper_trades
    WHERE status != 'OPEN'
      AND outcome_date IS NOT NULL
      AND outcome_date >= ?
      AND outcome_date <= ?
  `,
    )
    .all(windowStart.d, asOf) as Array<{ status: PaperTradeStatus; pnlPct: number | null }>;

  const openCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM paper_trades WHERE status = 'OPEN'`).get() as {
      c: number;
    }
  ).c;

  let winCount = 0;
  let lossCount = 0;
  let timeCount = 0;
  const winnerPnls: number[] = [];
  const loserPnls: number[] = [];
  let sumPnl = 0;

  for (const r of closedRows) {
    const pnl = r.pnlPct ?? 0;
    sumPnl += pnl;
    if (r.status === 'CLOSED_WIN') {
      winCount++;
      winnerPnls.push(pnl);
    } else if (r.status === 'CLOSED_LOSS') {
      lossCount++;
      loserPnls.push(pnl);
    } else if (r.status === 'CLOSED_TIME') {
      timeCount++;
      if (pnl >= 0) {
        winnerPnls.push(pnl);
      } else {
        loserPnls.push(pnl);
      }
    }
  }

  const closedCount = closedRows.length;
  const minSampleMet = closedCount >= MIN_SAMPLE_CLOSED;

  let winRate: number | null = null;
  if (minSampleMet && closedCount > 0) {
    const strictWins = closedRows.filter((r) => r.status === 'CLOSED_WIN').length;
    winRate = strictWins / closedCount;
  }

  const avgWinnerPct =
    winnerPnls.length > 0 ? winnerPnls.reduce((a, b) => a + b, 0) / winnerPnls.length : null;
  const avgLoserPct =
    loserPnls.length > 0 ? loserPnls.reduce((a, b) => a + b, 0) / loserPnls.length : null;
  const expectancyPct = closedCount > 0 ? sumPnl / closedCount : null;

  return {
    windowDays: days,
    asOf,
    closedCount,
    openCount,
    winCount,
    lossCount,
    timeCount,
    winRate,
    avgWinnerPct,
    avgLoserPct,
    expectancyPct,
    minSampleMet,
  };
}
