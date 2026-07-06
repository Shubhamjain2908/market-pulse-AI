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
  QuarterlyFundamentals,
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

/** Prior NSE session close strictly before `beforeDate` (for gap circuit breakers). */
export function getPrevClose(
  symbol: string,
  beforeDate: string,
  db: DatabaseType = getDb(),
): number | undefined {
  const row = db
    .prepare(
      `
      SELECT close FROM quotes
      WHERE symbol = ? AND exchange = 'NSE' AND date < ?
      ORDER BY date DESC LIMIT 1
    `,
    )
    .get(symbol, beforeDate) as { close: number } | undefined;
  return row?.close;
}

export function hasCorporateActionInRange(
  symbol: string,
  afterExclusive: string,
  beforeInclusive: string,
  db: DatabaseType = getDb(),
): boolean {
  const row = db
    .prepare(
      `
      SELECT 1 AS x FROM corporate_actions
      WHERE symbol = ? AND ex_date > ? AND ex_date <= ?
      LIMIT 1
    `,
    )
    .get(symbol, afterExclusive, beforeInclusive) as { x: number } | undefined;
  return row != null;
}

// ---------------------------------------------------------------------------
// Fundamentals
// ---------------------------------------------------------------------------

export function upsertFundamentals(rows: Fundamentals[], db: DatabaseType = getDb()): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO fundamentals (
      symbol, as_of, market_cap, pe, pb, peg, roe, roce,
      revenue_growth_yoy, profit_growth_yoy, net_profit_ttm, debt_to_equity,
      promoter_holding_pct, promoter_holding_change_qoq, dividend_yield, source
    ) VALUES (
      @symbol, @asOf, @marketCap, @pe, @pb, @peg, @roe, @roce,
      @revenueGrowthYoY, @profitGrowthYoY, @netProfitTtm, @debtToEquity,
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
      net_profit_ttm              = excluded.net_profit_ttm,
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
        netProfitTtm: r.netProfitTtm ?? null,
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

export interface QualityGarpFundamentalRow {
  symbol: string;
  latestRoe: number | null;
  prevRoe: number | null;
  thirdRoe: number | null;
  latestRoce: number | null;
  latestRevGrowth: number | null;
  pe: number | null;
  pb: number | null;
  peg: number | null;
  debtToEquity: number | null;
  marketCap: number | null;
  promoterHoldingPct: number | null;
  promoterHoldingChangeQoQ: number | null;
}

export interface QualityGarpFundamentalsOptions {
  /** Backtest replay: annual/snapshot rows with as_of <= screen date. Default false (live exact-match). */
  pointInTime?: boolean;
}

const QUALITY_GARP_FUNDAMENTALS_SELECT = `
  SELECT
    a1.symbol                                 AS symbol,
    a1.roe                                    AS latestRoe,
    a2.roe                                    AS prevRoe,
    a3.roe                                    AS thirdRoe,
    a1.roce                                   AS latestRoce,
    a1.revenue_growth_yoy                     AS latestRevGrowth,
    s.pe                                      AS pe,
    s.pb                                      AS pb,
    s.peg                                     AS peg,
    s.debt_to_equity                          AS debtToEquity,
    s.market_cap                              AS marketCap,
    p.promoter_holding_pct                    AS promoterHoldingPct,
    p.promoter_holding_change_qoq             AS promoterHoldingChangeQoQ
  FROM AnnualRanked a1
  LEFT JOIN AnnualRanked  a2 ON a1.symbol = a2.symbol AND a2.rn = 2
  LEFT JOIN AnnualRanked  a3 ON a1.symbol = a3.symbol AND a3.rn = 3
  LEFT JOIN SnapshotRanked s ON a1.symbol = s.symbol AND s.rn = 1
  LEFT JOIN PromoterLatest p ON a1.symbol = p.symbol AND p.rn = 1
  WHERE a1.rn = 1
    AND s.pe IS NOT NULL
    AND s.pb IS NOT NULL
`;

const QUALITY_GARP_FUNDAMENTALS_LIVE_SQL = `
  WITH AnnualRanked AS (
    SELECT symbol, roe, roce, revenue_growth_yoy, as_of,
      ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY as_of DESC) AS rn
    FROM fundamentals
    WHERE source = 'yahoo_annual'
  ),
  SnapshotRanked AS (
    SELECT symbol, pe, pb, peg, market_cap, debt_to_equity, source,
      ROW_NUMBER() OVER (
        PARTITION BY symbol
        ORDER BY CASE source WHEN 'yahoo_snapshot' THEN 0 WHEN 'screener' THEN 1 ELSE 2 END
      ) AS rn
    FROM fundamentals
    WHERE as_of = ? AND source IN ('yahoo_snapshot', 'screener')
  ),
  PromoterLatest AS (
    SELECT symbol, promoter_holding_pct, promoter_holding_change_qoq,
      ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY as_of DESC) AS rn
    FROM fundamentals
    WHERE source IN ('nse_shareholding', 'screener')
      AND promoter_holding_pct IS NOT NULL
  )
  ${QUALITY_GARP_FUNDAMENTALS_SELECT}
`;

const QUALITY_GARP_FUNDAMENTALS_PIT_SQL = `
  WITH AnnualEligible AS (
    SELECT symbol, roe, roce, revenue_growth_yoy, as_of,
      ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY as_of DESC) AS rn
    FROM fundamentals
    WHERE source = 'yahoo_annual' AND as_of <= ?
  ),
  AnnualRanked AS (
    SELECT symbol, roe, roce, revenue_growth_yoy, as_of, rn
    FROM AnnualEligible
  ),
  SnapshotEligible AS (
    SELECT symbol, pe, pb, peg, market_cap, debt_to_equity, source, as_of,
      ROW_NUMBER() OVER (
        PARTITION BY symbol
        ORDER BY as_of DESC,
          CASE source WHEN 'yahoo_snapshot' THEN 0 WHEN 'screener' THEN 1 ELSE 2 END
      ) AS rn
    FROM fundamentals
    WHERE source IN ('yahoo_snapshot', 'screener') AND as_of <= ?
  ),
  SnapshotRanked AS (
    SELECT symbol, pe, pb, peg, market_cap, debt_to_equity, source, rn
    FROM SnapshotEligible
    WHERE rn = 1
  ),
  PromoterLatest AS (
    SELECT symbol, promoter_holding_pct, promoter_holding_change_qoq,
      ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY as_of DESC) AS rn
    FROM fundamentals
    WHERE source IN ('nse_shareholding', 'screener')
      AND promoter_holding_pct IS NOT NULL
  )
  ${QUALITY_GARP_FUNDAMENTALS_SELECT}
`;

/** One-shot candidate fundamentals snapshot used by Quality-GARP screen evaluation. */
export function getQualityGarpFundamentals(
  asOfDate: string,
  db: DatabaseType = getDb(),
  opts: QualityGarpFundamentalsOptions = {},
): QualityGarpFundamentalRow[] {
  const pointInTime = opts.pointInTime === true;
  const sql = pointInTime ? QUALITY_GARP_FUNDAMENTALS_PIT_SQL : QUALITY_GARP_FUNDAMENTALS_LIVE_SQL;
  const binds = pointInTime ? [asOfDate, asOfDate] : [asOfDate];
  return db.prepare(sql).all(...binds) as QualityGarpFundamentalRow[];
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

/** Rolling cash-segment FII/DII nets for flow-attribution (up to 5 sessions on or before `asOf`). */
export interface FlowAttributionSnapshot {
  fiiNetSum: number;
  diiNetSum: number;
  sessionCount: number;
}

export function getFlowAttribution(db: DatabaseType, asOf: string): FlowAttributionSnapshot | null {
  const rows = db
    .prepare(
      `
      SELECT fii_net AS fiiNet, dii_net AS diiNet
      FROM fii_dii
      WHERE segment = 'cash' AND date <= ?
      ORDER BY date DESC
      LIMIT 5
    `,
    )
    .all(asOf) as Array<{ fiiNet: number; diiNet: number }>;

  if (rows.length === 0) return null;

  return {
    fiiNetSum: rows.reduce((s, r) => s + r.fiiNet, 0),
    diiNetSum: rows.reduce((s, r) => s + r.diiNet, 0),
    sessionCount: rows.length,
  };
}

// ---------------------------------------------------------------------------
// ETF iNAV snapshots (NSE /api/etf)
// ---------------------------------------------------------------------------

export interface InavSnapshotRow {
  symbol: string;
  date: string;
  inav: number;
  lastPrice: number;
  premiumDiscountPct: number;
  capturedAt: string;
}

export function upsertInavSnapshots(rows: InavSnapshotRow[], db: DatabaseType = getDb()): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO inav_snapshots (
      symbol, date, inav, last_price, premium_discount_pct, captured_at
    )
    VALUES (
      @symbol, @date, @inav, @lastPrice, @premiumDiscountPct, @capturedAt
    )
    ON CONFLICT(symbol, date) DO UPDATE SET
      inav                 = excluded.inav,
      last_price           = excluded.last_price,
      premium_discount_pct = excluded.premium_discount_pct,
      captured_at          = excluded.captured_at
  `);
  const tx = db.transaction((batch: InavSnapshotRow[]) => {
    for (const r of batch) stmt.run(r);
  });
  tx(rows);
  return rows.length;
}

export function getInavSnapshotsForDate(
  date: string,
  symbols: string[],
  db: DatabaseType = getDb(),
): InavSnapshotRow[] {
  if (symbols.length === 0) return [];
  const upper = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const placeholders = upper.map(() => '?').join(', ');
  return db
    .prepare(
      `
      SELECT
        symbol,
        date,
        inav,
        last_price AS lastPrice,
        premium_discount_pct AS premiumDiscountPct,
        captured_at AS capturedAt
      FROM inav_snapshots
      WHERE date = ? AND symbol IN (${placeholders})
    `,
    )
    .all(date, ...upper) as InavSnapshotRow[];
}

// ---------------------------------------------------------------------------
// COMEX gold COT (CFTC disaggregated)
// ---------------------------------------------------------------------------

export interface CotGoldRow {
  reportDate: string;
  mmLong: number;
  mmShort: number;
  mmNet: number;
  openInterest: number;
  mmNetOiRatio: number;
  ingestedAt: string;
}

export function insertCotGoldIgnore(row: CotGoldRow, db: DatabaseType = getDb()): boolean {
  const result = db
    .prepare(
      `
      INSERT OR IGNORE INTO cot_gold (
        report_date, mm_long, mm_short, mm_net, open_interest, mm_net_oi_ratio, ingested_at
      )
      VALUES (
        @reportDate, @mmLong, @mmShort, @mmNet, @openInterest, @mmNetOiRatio, @ingestedAt
      )
    `,
    )
    .run(row);
  return result.changes > 0;
}

export function getLatestCotGold(db: DatabaseType = getDb()): CotGoldRow | null {
  const row = db
    .prepare(
      `
      SELECT
        report_date AS reportDate,
        mm_long AS mmLong,
        mm_short AS mmShort,
        mm_net AS mmNet,
        open_interest AS openInterest,
        mm_net_oi_ratio AS mmNetOiRatio,
        ingested_at AS ingestedAt
      FROM cot_gold
      ORDER BY report_date DESC
      LIMIT 1
    `,
    )
    .get();
  return (row as CotGoldRow | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Quarterly Fundamentals (from Screener.in #quarters & #cash-flow tables)
// ---------------------------------------------------------------------------

export function upsertQuarterlyFundamentals(
  rows: QuarterlyFundamentals[],
  db: DatabaseType = getDb(),
): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO quarterly_fundamentals (
      symbol, quarter_end, revenue, operating_profit, opm_pct, net_profit, eps,
      operating_cash_flow, free_cash_flow, source
    ) VALUES (
      @symbol, @quarterEnd, @revenue, @operatingProfit, @opmPct, @netProfit, @eps,
      @operatingCashFlow, @freeCashFlow, @source
    )
    ON CONFLICT(symbol, quarter_end) DO UPDATE SET
      revenue            = COALESCE(excluded.revenue, quarterly_fundamentals.revenue),
      operating_profit   = COALESCE(excluded.operating_profit, quarterly_fundamentals.operating_profit),
      opm_pct            = COALESCE(excluded.opm_pct, quarterly_fundamentals.opm_pct),
      net_profit         = COALESCE(excluded.net_profit, quarterly_fundamentals.net_profit),
      eps                = COALESCE(excluded.eps, quarterly_fundamentals.eps),
      operating_cash_flow = COALESCE(excluded.operating_cash_flow, quarterly_fundamentals.operating_cash_flow),
      free_cash_flow     = COALESCE(excluded.free_cash_flow, quarterly_fundamentals.free_cash_flow),
      source             = excluded.source
  `);
  const tx = db.transaction((batch: QuarterlyFundamentals[]) => {
    for (const r of batch) {
      stmt.run({
        symbol: r.symbol,
        quarterEnd: r.quarterEnd,
        revenue: r.revenue ?? null,
        operatingProfit: r.operatingProfit ?? null,
        opmPct: r.opmPct ?? null,
        netProfit: r.netProfit ?? null,
        eps: r.eps ?? null,
        operatingCashFlow: r.operatingCashFlow ?? null,
        freeCashFlow: r.freeCashFlow ?? null,
        source: r.source,
      });
    }
  });
  tx(rows);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Quality Decay Score (QDS) — 6-signal Piotroski-style trajectory check
// ---------------------------------------------------------------------------

export interface QualityDecayResult {
  score: number; // 0–6
  signals: {
    netProfitPositive: boolean;
    netProfitImproving: boolean;
    ocfPositive: boolean;
    ocfExceedsNetProfit: boolean;
    opmImproving: boolean;
    revenueImproving: boolean;
  };
  quartersAvailable: number;
}

/**
 * Computes QDS for a symbol at a given asOf date.
 * Returns null when <5 quarters of quarterly_fundamentals data available (fail-open).
 * Matches the audit script used for P10 threshold calibration.
 */
export function getQualityDecayScore(
  symbol: string,
  asOf: string,
  db: DatabaseType = getDb(),
): QualityDecayResult | null {
  const rows = db
    .prepare(
      `
      SELECT quarter_end, net_profit, operating_cash_flow, opm_pct, revenue
      FROM quarterly_fundamentals
      WHERE symbol = ? AND quarter_end <= ?
      ORDER BY quarter_end DESC
      LIMIT 5
    `,
    )
    .all(symbol.toUpperCase(), asOf) as Array<{
    quarter_end: string;
    net_profit: number | null;
    operating_cash_flow: number | null;
    opm_pct: number | null;
    revenue: number | null;
  }>;

  if (rows.length < 5) return null;

  const latest = rows[0];
  const yearAgo = rows[4];
  if (!latest || !yearAgo) return null;

  const netProfitPositive = latest.net_profit != null && latest.net_profit > 0;
  const netProfitImproving =
    latest.net_profit != null && yearAgo.net_profit != null
      ? latest.net_profit > yearAgo.net_profit
      : false;
  const ocfPositive = latest.operating_cash_flow != null && latest.operating_cash_flow > 0;
  const ocfExceedsNetProfit =
    latest.operating_cash_flow != null && latest.net_profit != null
      ? latest.operating_cash_flow > latest.net_profit
      : false;
  const opmImproving =
    latest.opm_pct != null && yearAgo.opm_pct != null ? latest.opm_pct > yearAgo.opm_pct : false;
  const revenueImproving =
    latest.revenue != null && yearAgo.revenue != null ? latest.revenue > yearAgo.revenue : false;

  const signals = {
    netProfitPositive,
    netProfitImproving,
    ocfPositive,
    ocfExceedsNetProfit,
    opmImproving,
    revenueImproving,
  };

  const score = Object.values(signals).filter(Boolean).length;

  return { score, signals, quartersAvailable: rows.length };
}

// ---------------------------------------------------------------------------
// Trailing quarterly EPS growth — null if < 5 quarters (T vs T-4)
// ---------------------------------------------------------------------------

/**
 * Returns YoY EPS growth from quarterly_fundamentals: (eps_t - eps_t-4) / abs(eps_t-4)
 * Returns null if fewer than 5 non-null EPS quarters are available up to asOf.
 */
export function getTrailingEpsGrowth(
  symbol: string,
  asOf: string,
  db: DatabaseType = getDb(),
): number | null {
  const rows = db
    .prepare(`
      SELECT eps FROM quarterly_fundamentals
      WHERE symbol = ? AND eps IS NOT NULL AND quarter_end <= ?
      ORDER BY quarter_end DESC
      LIMIT 5
    `)
    .all(symbol.toUpperCase(), asOf) as Array<{ eps: number }>;

  if (rows.length < 5) return null;
  const epsT = rows[0]?.eps;
  const epsT4 = rows[4]?.eps;
  if (
    epsT == null ||
    epsT4 == null ||
    !Number.isFinite(epsT) ||
    !Number.isFinite(epsT4) ||
    epsT4 === 0
  )
    return null;
  return ((epsT - epsT4) / Math.abs(epsT4)) * 100;
}

// ---------------------------------------------------------------------------
// OPM stability — null if < quarters rows (fail-open)
// ---------------------------------------------------------------------------

export function getTrailingOpmStdDev(
  symbol: string,
  asOf: string,
  quarters: number = 4,
  db: DatabaseType = getDb(),
): number | null {
  const rows = db
    .prepare(`
      SELECT opm_pct FROM quarterly_fundamentals
      WHERE symbol = ? AND quarter_end <= ? AND opm_pct IS NOT NULL
      ORDER BY quarter_end DESC
      LIMIT ?
    `)
    .all(symbol.toUpperCase(), asOf, quarters) as Array<{ opm_pct: number }>;

  if (rows.length < quarters) return null;

  const n = rows.length;
  const sum = rows.reduce((s, r) => s + r.opm_pct, 0);
  const mean = sum / n;
  const variance = rows.reduce((s, r) => s + (r.opm_pct - mean) ** 2, 0) / n;
  return Math.sqrt(variance);
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
  /** Optional rubric JSON (anchors + LLM sub-scores + total) — Task A. */
  rubricJson?: string | null;
  /** Optional context refs JSON (data provenance) — Task C. */
  contextRefs?: string | null;
}

export function upsertThesis(row: UpsertThesisRow, db: DatabaseType = getDb()): void {
  db.prepare(`
    INSERT INTO theses (
      symbol, date, thesis, bull_case, bear_case, entry_zone, stop_loss,
      target, time_horizon, confidence, trigger_reason, model, raw_response,
      rubric_json, context_refs
    ) VALUES (
      @symbol, @date, @thesis, @bullCase, @bearCase, @entryZone, @stopLoss,
      @target, @timeHorizon, @confidence, @triggerReason, @model, @raw,
      @rubricJson, @contextRefs
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
      raw_response   = excluded.raw_response,
      rubric_json    = excluded.rubric_json,
      context_refs   = excluded.context_refs
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
    rubricJson: row.rubricJson ?? null,
    contextRefs: row.contextRefs ?? null,
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
  /** Optional data-provenance JSON (data-as-of timestamps for each context source). */
  contextRefs?: string | null;
}

export function getThesesForDate(date: string, db: DatabaseType = getDb()): StoredThesis[] {
  const rows = db
    .prepare(`
      SELECT symbol, date, thesis, bull_case, bear_case, entry_zone, stop_loss,
             target, time_horizon, confidence, trigger_reason, model,
             context_refs
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
    context_refs: string | null;
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
    contextRefs: r.context_refs,
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
// Promoter pledge (NSE shareholding pattern)
// ---------------------------------------------------------------------------

export interface PromoterPledgeRow {
  symbol: string;
  shpDate: string;
  pctSharesPledged: number | null;
  pctPromoterHolding: number | null;
  numSharesPledged: number | null;
  source?: string;
}

export function upsertPromoterPledgeRows(
  rows: PromoterPledgeRow[],
  db: DatabaseType = getDb(),
): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO promoter_pledge (
      symbol, shp_date, pct_shares_pledged, pct_promoter_holding,
      num_shares_pledged, source
    ) VALUES (
      @symbol, @shpDate, @pctSharesPledged, @pctPromoterHolding,
      @numSharesPledged, @source
    )
    ON CONFLICT(symbol, shp_date) DO UPDATE SET
      pct_shares_pledged   = excluded.pct_shares_pledged,
      pct_promoter_holding = excluded.pct_promoter_holding,
      num_shares_pledged   = excluded.num_shares_pledged,
      source               = excluded.source,
      ingested_at          = CURRENT_TIMESTAMP
  `);
  const tx = db.transaction((batch: PromoterPledgeRow[]) => {
    for (const r of batch) {
      stmt.run({
        symbol: r.symbol.toUpperCase(),
        shpDate: r.shpDate,
        pctSharesPledged: r.pctSharesPledged ?? null,
        pctPromoterHolding: r.pctPromoterHolding ?? null,
        numSharesPledged: r.numSharesPledged ?? null,
        source: r.source ?? 'nse',
      });
    }
  });
  tx(rows);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Concall Transcripts & Intel (Task B)
// ---------------------------------------------------------------------------

export interface ConcallTranscriptRow {
  symbol: string;
  announcedAt: string;
  attachmentUrl: string;
  kind: string;
  text: string | null;
  charCount: number | null;
  fetchedAt: string;
}

export function getTranscriptsWithoutIntel(
  limit: number = 25,
  db: DatabaseType = getDb(),
): ConcallTranscriptRow[] {
  return db
    .prepare(
      `
    SELECT ct.symbol, ct.announced_at AS announcedAt, ct.attachment_url AS attachmentUrl,
           ct.kind, ct.text, ct.char_count AS charCount, ct.fetched_at AS fetchedAt
    FROM concall_transcripts ct
    LEFT JOIN concall_intel ci
      ON ct.symbol = ci.symbol AND ct.announced_at = ci.announced_at
    WHERE ct.text IS NOT NULL AND ct.char_count >= 2000
      AND ct.kind = 'transcript'
      AND ci.symbol IS NULL
    ORDER BY ct.fetched_at ASC
    LIMIT ?
  `,
    )
    .all(limit) as ConcallTranscriptRow[];
}

export function insertConcallTranscript(
  row: Omit<ConcallTranscriptRow, 'fetchedAt'>,
  db: DatabaseType = getDb(),
): boolean {
  const result = db
    .prepare(
      `
    INSERT OR IGNORE INTO concall_transcripts (
      symbol, announced_at, attachment_url, kind, text, char_count
    ) VALUES (
      @symbol, @announcedAt, @attachmentUrl, @kind, @text, @charCount
    )
  `,
    )
    .run({
      symbol: row.symbol.toUpperCase(),
      announcedAt: row.announcedAt,
      attachmentUrl: row.attachmentUrl,
      kind: row.kind,
      text: row.text,
      charCount: row.charCount,
    });
  return result.changes > 0;
}

export interface ConcallIntelRow {
  symbol: string;
  announcedAt: string;
  quarterLabel: string | null;
  sentiment: string;
  credibilityStars: number;
  guidanceJson: string;
  deliveryJson: string | null;
  deflectionsJson: string | null;
  summary: string;
  model: string;
}

export function upsertConcallIntel(row: ConcallIntelRow, db: DatabaseType = getDb()): void {
  db.prepare(
    `
    INSERT INTO concall_intel (
      symbol, announced_at, quarter_label, sentiment, credibility_stars,
      guidance_json, delivery_json, deflections_json, summary, model
    ) VALUES (
      @symbol, @announcedAt, @quarterLabel, @sentiment, @credibilityStars,
      @guidanceJson, @deliveryJson, @deflectionsJson, @summary, @model
    )
    ON CONFLICT(symbol, announced_at) DO UPDATE SET
      quarter_label     = excluded.quarter_label,
      sentiment         = excluded.sentiment,
      credibility_stars = excluded.credibility_stars,
      guidance_json     = excluded.guidance_json,
      delivery_json     = excluded.delivery_json,
      deflections_json  = excluded.deflections_json,
      summary           = excluded.summary,
      model             = excluded.model,
      created_at        = datetime('now')
  `,
  ).run({
    symbol: row.symbol.toUpperCase(),
    announcedAt: row.announcedAt,
    quarterLabel: row.quarterLabel ?? null,
    sentiment: row.sentiment,
    credibilityStars: row.credibilityStars,
    guidanceJson: row.guidanceJson,
    deliveryJson: row.deliveryJson ?? null,
    deflectionsJson: row.deflectionsJson ?? null,
    summary: row.summary,
    model: row.model,
  });
}

export function getLatestConcallIntel(
  symbol: string,
  asOf: string,
  db: DatabaseType = getDb(),
): ConcallIntelRow | null {
  const row = db
    .prepare(
      `
    SELECT symbol, announced_at AS announcedAt, quarter_label AS quarterLabel,
           sentiment, credibility_stars AS credibilityStars,
           guidance_json AS guidanceJson, delivery_json AS deliveryJson,
           deflections_json AS deflectionsJson, summary, model
    FROM concall_intel
    WHERE symbol = ? AND announced_at < ? AND announced_at >= date(?, '-90 days')
    ORDER BY announced_at DESC
    LIMIT 1
  `,
    )
    .get(symbol.toUpperCase(), asOf, asOf) as ConcallIntelRow | undefined;
  return row ?? null;
}

export function getRecentConcallIntelForSymbols(
  symbols: string[],
  asOf: string,
  db: DatabaseType = getDb(),
): Map<string, ConcallIntelRow> {
  if (symbols.length === 0) return new Map();
  const upper = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const placeholders = upper.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `
    SELECT symbol, announced_at AS announcedAt, quarter_label AS quarterLabel,
           sentiment, credibility_stars AS credibilityStars,
           guidance_json AS guidanceJson, delivery_json AS deliveryJson,
           deflections_json AS deflectionsJson, summary, model
    FROM concall_intel
    WHERE symbol IN (${placeholders})
      AND announced_at >= date(?, '-90 days')
    ORDER BY symbol, announced_at DESC
  `,
    )
    .all(...upper, asOf) as ConcallIntelRow[];
  const m = new Map<string, ConcallIntelRow>();
  for (const r of rows) {
    const sym = r.symbol.toUpperCase();
    if (!m.has(sym)) m.set(sym, r);
  }
  return m;
}

export function getConcallIntelCoverage(
  symbols: string[],
  db: DatabaseType = getDb(),
): { covered: number; total: number; pct: number } {
  if (symbols.length === 0) return { covered: 0, total: 0, pct: 0 };
  const upper = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const placeholders = upper.map(() => '?').join(', ');
  const row = db
    .prepare(
      `
    SELECT COUNT(DISTINCT symbol) AS cnt FROM concall_intel
    WHERE symbol IN (${placeholders})
  `,
    )
    .get(...upper) as { cnt: number };
  return {
    covered: row.cnt,
    total: symbols.length,
    pct: symbols.length > 0 ? (row.cnt / symbols.length) * 100 : 0,
  };
}

export function getConcallTranscriptsForDate(
  date: string,
  symbols: string[],
  db: DatabaseType = getDb(),
): ConcallTranscriptRow[] {
  if (symbols.length === 0) return [];
  const upper = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const placeholders = upper.map(() => '?').join(', ');
  return db
    .prepare(
      `
    SELECT symbol, announced_at AS announcedAt, attachment_url AS attachmentUrl,
           kind, text, char_count AS charCount, fetched_at AS fetchedAt
    FROM concall_transcripts
    WHERE symbol IN (${placeholders}) AND announced_at = ?
    ORDER BY symbol, announced_at DESC
  `,
    )
    .all(...upper, date) as ConcallTranscriptRow[];
}

export function getConcallIntelForDate(
  date: string,
  symbols: string[],
  db: DatabaseType = getDb(),
): ConcallIntelRow[] {
  if (symbols.length === 0) return [];
  const upper = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const placeholders = upper.map(() => '?').join(', ');
  return db
    .prepare(
      `
    SELECT symbol, announced_at AS announcedAt, quarter_label AS quarterLabel,
           sentiment, credibility_stars AS credibilityStars,
           guidance_json AS guidanceJson, delivery_json AS deliveryJson,
           deflections_json AS deflectionsJson, summary, model
    FROM concall_intel
    WHERE symbol IN (${placeholders})
      AND announced_at >= date(?, '-14 days')
      AND announced_at <= date(?)
    ORDER BY symbol, announced_at DESC
  `,
    )
    .all(...upper, date, date) as ConcallIntelRow[];
}

export function getPromoterPledgeSnapshot(
  symbol: string,
  asOf: string,
  db: DatabaseType = getDb(),
): { latest: PromoterPledgeRow | null; qoqDelta: number | null } {
  const rows = db
    .prepare(
      `
    SELECT symbol, shp_date AS shpDate,
           pct_shares_pledged AS pctSharesPledged,
           pct_promoter_holding AS pctPromoterHolding,
           num_shares_pledged AS numSharesPledged
    FROM promoter_pledge
    WHERE symbol = ? AND shp_date <= ?
    ORDER BY shp_date DESC
    LIMIT 2
  `,
    )
    .all(symbol.toUpperCase(), asOf) as PromoterPledgeRow[];
  const latest = rows[0] ?? null;
  const cur = rows[0]?.pctSharesPledged;
  const prev = rows[1]?.pctSharesPledged;
  const qoqDelta = cur != null && prev != null && rows.length >= 2 ? cur - prev : null;
  return { latest, qoqDelta };
}

// ---------------------------------------------------------------------------
// Paper trades (forward-testing ledger)
// ---------------------------------------------------------------------------

export type PaperTradeSignalType = 'AI_PICK' | 'PORTFOLIO_ADD' | 'momentum_mf' | 'catalyst_entry';
export type PaperTradeStatus = 'OPEN' | 'CLOSED_WIN' | 'CLOSED_LOSS' | 'CLOSED_TIME';
export type PaperTradeHorizon = 'short' | 'medium' | 'long';
export type PaperTradeStopType = 'trailing' | 'fixed';

export interface PaperTradeInsertRow {
  symbol: string;
  signalType: PaperTradeSignalType;
  sourceDate: string;
  entryPrice: number;
  stopLoss: number;
  target: number;
  timeHorizon: PaperTradeHorizon;
  maxHoldDays: number;
  stopType?: PaperTradeStopType;
  trailingMultiplier?: number;
  atr14AtEntry?: number | null;
  notes?: string | null;
  positionWeightPct?: number | null;
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
  stopType: PaperTradeStopType;
  stopRaisedToday: number | null;
  exitReason: ExitReason | null;
  positionWeightPct: number | null;
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
      time_horizon, max_hold_days, stop_type, trailing_multiplier, atr14_at_entry,
      status, notes, position_weight_pct
    ) VALUES (
      @symbol, @signalType, @sourceDate, @entryPrice, @stopLoss, @target,
      @timeHorizon, @maxHoldDays, @stopType, @trailingMultiplier, @atr14AtEntry,
      'OPEN', @notes, @positionWeightPct
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
      stopType: row.stopType ?? 'trailing',
      trailingMultiplier: row.trailingMultiplier ?? 2.5,
      atr14AtEntry: row.atr14AtEntry ?? null,
      notes: row.notes ?? null,
      positionWeightPct: row.positionWeightPct ?? null,
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
           stop_type AS stopType,
           stop_raised_today AS stopRaisedToday,
           exit_reason AS exitReason,
           position_weight_pct AS positionWeightPct
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
    stopType: PaperTradeStopType;
    stopRaisedToday: number | null;
    exitReason: ExitReason | null;
    positionWeightPct: number | null;
  }>;

  return rows;
}

/** True when any OPEN `paper_trades` row exists for `symbol` (any `signal_type`). */
export function hasOpenPaperTradeForSymbol(symbol: string, db: DatabaseType = getDb()): boolean {
  const row = db
    .prepare(
      `
      SELECT 1 FROM paper_trades
      WHERE symbol = ? AND status = 'OPEN'
      LIMIT 1
    `,
    )
    .get(symbol.toUpperCase());
  return row != null;
}

/** Distinct symbols with at least one OPEN `paper_trades` row (any `signal_type`). */
export function getDistinctOpenPaperTradeSymbols(db: DatabaseType = getDb()): string[] {
  const rows = db
    .prepare(
      `
      SELECT DISTINCT symbol
      FROM paper_trades
      WHERE status = 'OPEN'
      ORDER BY symbol
    `,
    )
    .all() as Array<{ symbol: string }>;
  return rows.map((r) => r.symbol.toUpperCase());
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
           stop_type AS stopType,
           stop_raised_today AS stopRaisedToday,
           exit_reason AS exitReason,
           position_weight_pct AS positionWeightPct
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
    stopType: PaperTradeStopType;
    stopRaisedToday: number | null;
    exitReason: ExitReason | null;
    positionWeightPct: number | null;
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
        notes = CASE WHEN @notes IS NOT NULL THEN @notes ELSE notes END,
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
  weightedExpectancyPct: number | null;
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

  const weightedRow = db
    .prepare(
      `
    SELECT
      SUM(pnl_pct * position_weight_pct) AS wSum,
      SUM(position_weight_pct) AS wDenom
    FROM paper_trades
    WHERE status != 'OPEN'
      AND outcome_date IS NOT NULL
      AND outcome_date >= ?
      AND outcome_date <= ?
      AND position_weight_pct IS NOT NULL
  `,
    )
    .get(windowStart.d, asOf) as { wSum: number | null; wDenom: number | null };
  const weightedExpectancyPct =
    weightedRow.wDenom != null && weightedRow.wDenom > 0 && weightedRow.wSum != null
      ? weightedRow.wSum / weightedRow.wDenom
      : null;

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
    weightedExpectancyPct,
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
