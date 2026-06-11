/**
 * SQLite helpers for `regime_daily` and `regime_strategy_gate`.
 */

import type { Database as DatabaseType, Statement } from 'better-sqlite3';
import { child } from '../logger.js';
import { lastOpenOnOrBefore } from '../market/trading-days.js';
import type { Regime, RegimeRow, StrategyGateRow } from '../types/regime.js';
import { RegimeSchema } from '../types/regime.js';
import { getDb } from './connection.js';

const log = child({ component: 'regime-queries' });

const SELECT_STRATEGY_GATE_ALLOWED_SQL =
  'SELECT allowed FROM regime_strategy_gate WHERE strategy_id = ? AND regime = ?';

const strategyGateAllowedStmtByDb = new WeakMap<DatabaseType, Statement>();

function strategyGateAllowedStmt(db: DatabaseType): Statement {
  let stmt = strategyGateAllowedStmtByDb.get(db);
  if (!stmt) {
    stmt = db.prepare(SELECT_STRATEGY_GATE_ALLOWED_SQL);
    strategyGateAllowedStmtByDb.set(db, stmt);
  }
  return stmt;
}

function parseRegimeRow(row: Record<string, unknown>): RegimeRow {
  const regimeParsed = RegimeSchema.safeParse(row.regime);
  const prevParsed =
    row.prev_regime == null
      ? { success: true as const, data: null }
      : RegimeSchema.safeParse(row.prev_regime);
  if (!regimeParsed.success) throw new Error(`invalid regime in DB: ${String(row.regime)}`);
  return {
    id: row.id != null ? Number(row.id) : undefined,
    date: String(row.date),
    regime: regimeParsed.data,
    scoreTotal: Number(row.score_total),
    scoreTrend: Number(row.score_trend),
    scoreVix: Number(row.score_vix),
    scoreFii: Number(row.score_fii),
    scoreBreadth: Number(row.score_breadth),
    vixValue: row.vix_value == null ? null : Number(row.vix_value),
    niftyVsSma200: row.nifty_vs_sma200 == null ? null : Number(row.nifty_vs_sma200),
    fii20dNet: row.fii_20d_net == null ? null : Number(row.fii_20d_net),
    adRatio: row.ad_ratio == null ? null : Number(row.ad_ratio),
    pctAboveSma200: row.pct_above_sma200 == null ? null : Number(row.pct_above_sma200),
    crisisOverride: Number(row.crisis_override) === 1,
    narrative: row.narrative == null ? null : String(row.narrative),
    prevRegime: prevParsed.success ? prevParsed.data : null,
    regimeAge: Number(row.regime_age),
    createdAt: row.created_at != null ? String(row.created_at) : undefined,
  };
}

export function getTodayRegime(date: string, db: DatabaseType = getDb()): RegimeRow | null {
  const row = db.prepare('SELECT * FROM regime_daily WHERE date = ?').get(date) as
    | Record<string, unknown>
    | undefined;
  return row ? parseRegimeRow(row) : null;
}

/**
 * Same session key as `prepareRegimeDaily` / `runRegimeAgent`: last **open** NSE session on or before
 * the calendar day (so briefing `-d` on a weekend/holiday still loads the latest `regime_daily` row).
 */
export function getRegimeForCalendarDate(
  calendarDate: string,
  db: DatabaseType = getDb(),
): RegimeRow | null {
  const sessionDate = lastOpenOnOrBefore(calendarDate) ?? calendarDate;
  return getTodayRegime(sessionDate, db);
}

export function getRegimeHistory(
  days: number,
  date: string,
  db: DatabaseType = getDb(),
): RegimeRow[] {
  const rows = db
    .prepare(
      `
      SELECT * FROM regime_daily
      WHERE date <= ?
      ORDER BY date DESC
      LIMIT ?
    `,
    )
    .all(date, days) as Record<string, unknown>[];
  return rows.map(parseRegimeRow);
}

export interface InsertRegimeRowInput {
  date: string;
  regime: Regime;
  scoreTotal: number;
  scoreTrend: number;
  scoreVix: number;
  scoreFii: number;
  scoreBreadth: number;
  vixValue: number | null;
  niftyVsSma200: number | null;
  fii20dNet: number | null;
  adRatio: number | null;
  pctAboveSma200: number | null;
  crisisOverride: boolean;
  narrative: string | null;
  prevRegime: Regime | null;
  regimeAge: number;
}

export function insertRegimeRow(input: InsertRegimeRowInput, db: DatabaseType = getDb()): void {
  db.prepare(
    `
    INSERT INTO regime_daily (
      date, regime, score_total, score_trend, score_vix, score_fii, score_breadth,
      vix_value, nifty_vs_sma200, fii_20d_net, ad_ratio, pct_above_sma200,
      crisis_override, narrative, prev_regime, regime_age
    ) VALUES (
      @date, @regime, @score_total, @score_trend, @score_vix, @score_fii, @score_breadth,
      @vix_value, @nifty_vs_sma200, @fii_20d_net, @ad_ratio, @pct_above_sma200,
      @crisis_override, @narrative, @prev_regime, @regime_age
    )
    ON CONFLICT(date) DO UPDATE SET
      regime = excluded.regime,
      score_total = excluded.score_total,
      score_trend = excluded.score_trend,
      score_vix = excluded.score_vix,
      score_fii = excluded.score_fii,
      score_breadth = excluded.score_breadth,
      vix_value = excluded.vix_value,
      nifty_vs_sma200 = excluded.nifty_vs_sma200,
      fii_20d_net = excluded.fii_20d_net,
      ad_ratio = excluded.ad_ratio,
      pct_above_sma200 = excluded.pct_above_sma200,
      crisis_override = excluded.crisis_override,
      narrative = excluded.narrative,
      prev_regime = excluded.prev_regime,
      regime_age = excluded.regime_age
    `,
  ).run({
    date: input.date,
    regime: input.regime,
    score_total: input.scoreTotal,
    score_trend: input.scoreTrend,
    score_vix: input.scoreVix,
    score_fii: input.scoreFii,
    score_breadth: input.scoreBreadth,
    vix_value: input.vixValue,
    nifty_vs_sma200: input.niftyVsSma200,
    fii_20d_net: input.fii20dNet,
    ad_ratio: input.adRatio,
    pct_above_sma200: input.pctAboveSma200,
    crisis_override: input.crisisOverride ? 1 : 0,
    narrative: input.narrative,
    prev_regime: input.prevRegime,
    regime_age: input.regimeAge,
  });
}

/**
 * Fail-CLOSED: a missing (strategy_id, regime) row means
 * DISALLOWED. Seed config/strategy-gates.json must cover
 * every (strategy_id, regime) tuple including CRISIS rows
 * for every strategy. See guardrails.md Rule 15.
 */
export function isStrategyAllowed(
  strategyId: string,
  regime: string,
  db: DatabaseType = getDb(),
): boolean {
  const row = strategyGateAllowedStmt(db).get(strategyId, regime) as
    | { allowed: number }
    | undefined;
  if (row == null) {
    log.warn({ strategyId, regime }, 'no gate row found — failing closed (DISALLOWED)');
    return false;
  }
  return row.allowed === 1;
}

export function getSizeMultiplier(
  strategyId: string,
  regime: string,
  db: DatabaseType = getDb(),
): number {
  const row = db
    .prepare(
      'SELECT size_multiplier FROM regime_strategy_gate WHERE strategy_id = ? AND regime = ?',
    )
    .get(strategyId, regime) as { size_multiplier: number } | undefined;
  if (!row) return 1;
  return row.size_multiplier;
}

/** Allowed strategies for a regime (from `regime_strategy_gate`). */
export interface RegimeGateSummaryRow {
  strategyId: string;
  sizeMultiplier: number;
}

/**
 * Strategies allowed (`allowed = 1`) for this regime, ordered by id.
 */
export function listAllowedGatesForRegime(
  regime: string,
  db: DatabaseType = getDb(),
): RegimeGateSummaryRow[] {
  const rows = db
    .prepare(
      `
      SELECT strategy_id, size_multiplier FROM regime_strategy_gate
      WHERE regime = ? AND allowed = 1
      ORDER BY strategy_id
    `,
    )
    .all(regime) as { strategy_id: string; size_multiplier: number }[];
  return rows.map((r) => ({
    strategyId: r.strategy_id,
    sizeMultiplier: r.size_multiplier,
  }));
}

/** Total rows in the gate table for this regime (allowed + disallowed). */
export function countGatesForRegime(regime: string, db: DatabaseType = getDb()): number {
  const row = db
    .prepare('SELECT COUNT(*) as c FROM regime_strategy_gate WHERE regime = ?')
    .get(regime) as { c: number } | undefined;
  return row?.c ?? 0;
}

export function seedStrategyGates(rows: StrategyGateRow[], db: DatabaseType = getDb()): number {
  const stmt = db.prepare(`
    INSERT INTO regime_strategy_gate (strategy_id, regime, allowed, size_multiplier, notes)
    VALUES (@strategyId, @regime, @allowed, @sizeMultiplier, @notes)
    ON CONFLICT(strategy_id, regime) DO UPDATE SET
      allowed = excluded.allowed,
      size_multiplier = excluded.size_multiplier,
      notes = excluded.notes
  `);
  const tx = db.transaction((batch: StrategyGateRow[]) => {
    for (const r of batch) {
      stmt.run({
        strategyId: r.strategyId,
        regime: r.regime,
        allowed: r.allowed ? 1 : 0,
        sizeMultiplier: r.sizeMultiplier,
        notes: r.notes ?? null,
      });
    }
  });
  tx(rows);
  return rows.length;
}
