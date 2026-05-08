/**
 * Hand-written, prepared-statement query helpers. Kept thin and explicit -
 * we'd rather grow this file than reach for an ORM.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import type { MomentumRebalanceSummary } from '../briefing/momentum-card.js';
import type {
  FiiDiiRow,
  Fundamentals,
  NewsItem,
  RawQuote,
  ScreenResult,
  Signal,
  Thesis,
} from '../types/domain.js';
import type { ExitReason } from '../types/trailing-stop.js';
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

/** Latest NSE cash close on or before `asOf` (for rebalance / regime exits). */
export function getNseCloseOnOrBefore(
  symbol: string,
  asOf: string,
  db: DatabaseType = getDb(),
): number | null {
  const row = db
    .prepare(
      `
    SELECT close FROM quotes
    WHERE symbol = ? AND exchange = 'NSE' AND date <= ?
    ORDER BY date DESC LIMIT 1
  `,
    )
    .get(symbol.toUpperCase(), asOf) as { close: number } | undefined;
  if (!row || !Number.isFinite(row.close)) return null;
  return row.close;
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

export type PaperTradeSignalType = 'AI_PICK' | 'PORTFOLIO_ADD' | 'momentum_mf';
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
  notes?: string | null;
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
  highestCloseSinceEntry: number | null;
  atr14AtEntry: number | null;
  trailingMultiplier: number | null;
  stopRaisedToday: number | null;
  exitReason: ExitReason | null;
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
      time_horizon, max_hold_days, status, notes
    ) VALUES (
      @symbol, @signalType, @sourceDate, @entryPrice, @stopLoss, @target,
      @timeHorizon, @maxHoldDays, 'OPEN', @notes
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
      notes: row.notes ?? null,
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
           pnl_pct AS pnlPct, notes, created_at AS createdAt,
           highest_close_since_entry AS highestCloseSinceEntry,
           atr14_at_entry AS atr14AtEntry,
           trailing_multiplier AS trailingMultiplier,
           stop_raised_today AS stopRaisedToday,
           exit_reason AS exitReason
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
    highestCloseSinceEntry: number | null;
    atr14AtEntry: number | null;
    trailingMultiplier: number | null;
    stopRaisedToday: number | null;
    exitReason: ExitReason | null;
  }>;

  return rows;
}

/** Open rows for a single strategy (`signal_type`). */
export function getOpenPaperTradesForSignal(
  signalType: PaperTradeSignalType,
  db: DatabaseType = getDb(),
): PaperTradeRow[] {
  const rows = db
    .prepare(
      `
    SELECT id, symbol, signal_type AS signalType, source_date AS sourceDate,
           entry_price AS entryPrice, stop_loss AS stopLoss, target,
           time_horizon AS timeHorizon, max_hold_days AS maxHoldDays,
           status, outcome_date AS outcomeDate, exit_price AS exitPrice,
           pnl_pct AS pnlPct, notes, created_at AS createdAt,
           highest_close_since_entry AS highestCloseSinceEntry,
           atr14_at_entry AS atr14AtEntry,
           trailing_multiplier AS trailingMultiplier,
           stop_raised_today AS stopRaisedToday,
           exit_reason AS exitReason
    FROM paper_trades
    WHERE status = 'OPEN' AND signal_type = ?
    ORDER BY source_date ASC, id ASC
  `,
    )
    .all(signalType) as Array<{
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
    highestCloseSinceEntry: number | null;
    atr14AtEntry: number | null;
    trailingMultiplier: number | null;
    stopRaisedToday: number | null;
    exitReason: ExitReason | null;
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
  /** Omit to leave DB `exit_reason` unchanged (legacy callers). Pass to tag trailing/target/time exits (Phase 3). */
  exitReason?: ExitReason | null,
): void {
  db.prepare(`
    UPDATE paper_trades
    SET status = @status,
        outcome_date = @outcomeDate,
        exit_price = @exitPrice,
        pnl_pct = @pnlPct,
        notes = COALESCE(@notes, notes),
        stop_raised_today = 0,
        exit_reason = CASE WHEN @applyExitReason = 1 THEN @exitReason ELSE exit_reason END
    WHERE id = @id AND status = 'OPEN'
  `).run({
    id,
    status,
    outcomeDate,
    exitPrice,
    pnlPct,
    notes: notes ?? null,
    applyExitReason: exitReason !== undefined ? 1 : 0,
    exitReason: exitReason ?? null,
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

// ---------------------------------------------------------------------------
// Momentum rebalance → briefing (persisted for weekend `brief` without --brief)
// ---------------------------------------------------------------------------

/** Top names by ascending `mom_rank` for a session (excludes `mom_rank_excluded`). */
export interface MomentumRankSnapshotRow {
  symbol: string;
  rank: number;
  composite: number | null;
  falseFlag: number | null;
}

export function getTopMomentumRankSnapshotForSession(
  sessionDate: string,
  limit: number,
  db: DatabaseType = getDb(),
): MomentumRankSnapshotRow[] {
  const rows = db
    .prepare(
      `
    SELECT r.symbol AS symbol, r.value AS rank, c.value AS composite, f.value AS false_flag
    FROM signals r
    LEFT JOIN signals c ON c.symbol = r.symbol AND c.date = r.date AND c.name = 'mom_composite_score'
    LEFT JOIN signals f ON f.symbol = r.symbol AND f.date = r.date AND f.name = 'mom_false_flag'
    WHERE r.date = ? AND r.name = 'mom_rank'
      AND NOT EXISTS (
        SELECT 1 FROM signals x
        WHERE x.symbol = r.symbol AND x.date = r.date AND x.name = 'mom_rank_excluded' AND x.value >= 1
      )
    ORDER BY r.value ASC, r.symbol ASC
    LIMIT ?
  `,
    )
    .all(sessionDate, limit) as Array<{
    symbol: string;
    rank: number;
    composite: number | null;
    false_flag: number | null;
  }>;
  return rows.map((r) => ({
    symbol: r.symbol.toUpperCase(),
    rank: r.rank,
    composite: r.composite ?? null,
    falseFlag: r.false_flag ?? null,
  }));
}

export function upsertMomentumRebalanceBriefing(
  row: MomentumRebalanceSummary,
  db: DatabaseType = getDb(),
): void {
  db.prepare(
    `
    INSERT INTO momentum_rebalance_briefing (
      calendar_date, session_date, regime_allowed, regime, closed_rank_decay,
      entries_inserted, unchanged_held, sector_cap_blocked, blackout_blocked, skipped_reason,
      thesis_failed, ranker_universe_size, ranker_eligible_count
    ) VALUES (
      @calendarDate, @sessionDate, @regimeAllowed, @regime, @closedRankDecay,
      @entriesInserted, @unchangedHeld, @sectorCapBlocked, @blackoutBlocked, @skippedReason,
      @thesisFailed, @rankerUniverseSize, @rankerEligibleCount
    )
    ON CONFLICT(calendar_date) DO UPDATE SET
      session_date       = excluded.session_date,
      regime_allowed     = excluded.regime_allowed,
      regime             = excluded.regime,
      closed_rank_decay  = excluded.closed_rank_decay,
      entries_inserted   = excluded.entries_inserted,
      unchanged_held     = excluded.unchanged_held,
      sector_cap_blocked = excluded.sector_cap_blocked,
      blackout_blocked   = excluded.blackout_blocked,
      skipped_reason     = excluded.skipped_reason,
      thesis_failed         = excluded.thesis_failed,
      ranker_universe_size  = excluded.ranker_universe_size,
      ranker_eligible_count = excluded.ranker_eligible_count,
      updated_at         = datetime('now')
  `,
  ).run({
    calendarDate: row.calendarDate,
    sessionDate: row.sessionDate,
    regimeAllowed: row.regimeAllowed ? 1 : 0,
    regime: row.regime ?? null,
    closedRankDecay: row.closedRankDecay,
    entriesInserted: row.entriesInserted,
    unchangedHeld: row.unchangedHeld,
    sectorCapBlocked: row.sectorCapBlocked,
    blackoutBlocked: row.blackoutBlocked,
    skippedReason: row.skippedReason ?? null,
    thesisFailed: row.thesisFailed ?? null,
    rankerUniverseSize: row.rankerSnapshot?.universeSize ?? null,
    rankerEligibleCount: row.rankerSnapshot?.eligibleCount ?? null,
  });
}

export function getMomentumRebalanceBriefingForCalendarDate(
  calendarDate: string,
  db: DatabaseType = getDb(),
): MomentumRebalanceSummary | null {
  const r = db
    .prepare(
      `
    SELECT calendar_date AS calendarDate, session_date AS sessionDate,
           regime_allowed AS regimeAllowed, regime,
           closed_rank_decay AS closedRankDecay,
           entries_inserted AS entriesInserted,
           unchanged_held AS unchangedHeld,
           sector_cap_blocked AS sectorCapBlocked,
           blackout_blocked AS blackoutBlocked,
           skipped_reason AS skippedReason,
           thesis_failed AS thesisFailed,
           ranker_universe_size AS rankerUniverseSize,
           ranker_eligible_count AS rankerEligibleCount
    FROM momentum_rebalance_briefing
    WHERE calendar_date = ?
  `,
    )
    .get(calendarDate) as
    | {
        calendarDate: string;
        sessionDate: string;
        regimeAllowed: number;
        regime: string | null;
        closedRankDecay: number;
        entriesInserted: number;
        unchangedHeld: number;
        sectorCapBlocked: number;
        blackoutBlocked: number;
        skippedReason: string | null;
        thesisFailed: number | null;
        rankerUniverseSize: number | null;
        rankerEligibleCount: number | null;
      }
    | undefined;
  if (!r) return null;
  const rankerSnapshot =
    r.rankerUniverseSize != null &&
    r.rankerEligibleCount != null &&
    Number.isFinite(r.rankerUniverseSize) &&
    Number.isFinite(r.rankerEligibleCount)
      ? { universeSize: r.rankerUniverseSize, eligibleCount: r.rankerEligibleCount }
      : undefined;
  return {
    calendarDate: r.calendarDate,
    sessionDate: r.sessionDate,
    regimeAllowed: r.regimeAllowed === 1,
    regime: r.regime,
    closedRankDecay: r.closedRankDecay,
    entriesInserted: r.entriesInserted,
    unchangedHeld: r.unchangedHeld,
    sectorCapBlocked: r.sectorCapBlocked,
    blackoutBlocked: r.blackoutBlocked,
    skippedReason:
      r.skippedReason === 'regime_gate' || r.skippedReason === 'missing_regime'
        ? r.skippedReason
        : undefined,
    thesisFailed: r.thesisFailed ?? undefined,
    rankerSnapshot,
  };
}
