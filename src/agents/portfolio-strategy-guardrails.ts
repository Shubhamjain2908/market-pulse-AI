/**
 * Strategy-aware portfolio guardrails + entry-source inference.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import {
  QUALITY_GARP_DE_MAX,
  QUALITY_GARP_PEG_MAX,
  QUALITY_GARP_ROCE_MIN,
  QUALITY_GARP_ROE_MIN,
} from '../analysers/quality-garp.js';
import { loadMomentumConfig } from '../config/loaders.js';
import {
  getQualityGarpFundamentals,
  type PaperTradeSignalType,
  type QualityGarpFundamentalRow,
} from '../db/queries.js';
import type { PortfolioAction } from './portfolio-analyser.js';
import { HARD_CONCENTRATION_PCT } from './portfolio-context.js';

export type PortfolioEntrySource = PaperTradeSignalType | 'quality_garp' | 'unknown';

export interface StrategyGuardrailCtx {
  entrySource: PortfolioEntrySource;
  symbol: string;
  date: string;
  db: DatabaseType;
  pnlPct?: number | null;
  /** Invested-book weight % (LIQUIDCASE excluded from denominator). */
  weightPct?: number | null;
  /** Skip concentration guardrail (allocation instruments). */
  skipConcentration?: boolean;
}

export function truncateTriggerReason(s: string): string {
  if (s.length <= 280) return s;
  return `${s.slice(0, 276)}…`;
}

function prependTriggerReason(prefix: string, s: string): string {
  const out = `${prefix} — ${s}`;
  if (out.length <= 280) return out;
  return `${out.slice(0, 276)}…`;
}

const ACTION_RANK: Record<PortfolioAction['action'], number> = {
  HOLD: 0,
  ADD: 0,
  TRIM: 1,
  EXIT: 2,
};

function escalate(
  action: PortfolioAction,
  next: 'TRIM' | 'EXIT',
  prefix: string,
  detail: string,
  conviction: number,
): PortfolioAction {
  if (action.action === 'EXIT') return action;
  if (ACTION_RANK[next] <= ACTION_RANK[action.action]) return action;
  return {
    ...action,
    action: next,
    conviction: Math.max(action.conviction, conviction),
    triggerReason: prependTriggerReason(prefix, `${action.triggerReason} ${detail}`),
  };
}

// ponytail: load QG universe only on first quality_garp guardrail hit per session date
let qgCacheDate: string | null = null;
let qgCache: Map<string, QualityGarpFundamentalRow> | null = null;
const profitGrowthCache = new Map<string, number | null>();

function qualityGarpRow(
  symbol: string,
  date: string,
  db: DatabaseType,
): QualityGarpFundamentalRow | undefined {
  if (qgCacheDate !== date || !qgCache) {
    qgCacheDate = date;
    qgCache = new Map(
      getQualityGarpFundamentals(date, db, { pointInTime: true }).map((row) => [
        row.symbol.toUpperCase(),
        row,
      ]),
    );
    profitGrowthCache.clear();
  }
  return qgCache.get(symbol.toUpperCase());
}

function profitGrowthYoy(symbol: string, asOfDate: string, db: DatabaseType): number | null {
  const sym = symbol.toUpperCase();
  const cacheKey = `${sym}:${asOfDate}`;
  if (!profitGrowthCache.has(cacheKey)) {
    const row = db
      .prepare(
        `
        SELECT profit_growth_yoy AS profitGrowthYoy
        FROM fundamentals
        WHERE symbol = ? AND as_of <= ?
        ORDER BY as_of DESC
        LIMIT 1
      `,
      )
      .get(sym, asOfDate) as { profitGrowthYoy: number | null } | undefined;
    profitGrowthCache.set(cacheKey, row?.profitGrowthYoy ?? null);
  }
  return profitGrowthCache.get(cacheKey) ?? null;
}

/** Clears lazy guardrail caches between tests (same module + date). */
export function resetPortfolioGuardrailCachesForTests(): void {
  qgCacheDate = null;
  qgCache = null;
  profitGrowthCache.clear();
}

export function resolvePaperEntrySource(
  symbol: string,
  sourceDate: string,
  signalType: PaperTradeSignalType,
  db: DatabaseType,
): PortfolioEntrySource {
  if (signalType !== 'AI_PICK') return signalType;
  const qualityGarp = db
    .prepare(
      `
      SELECT 1
      FROM screens
      WHERE symbol = ? AND date = ? AND screen_name = 'quality_garp'
      LIMIT 1
    `,
    )
    .get(symbol.toUpperCase(), sourceDate);
  return qualityGarp ? 'quality_garp' : 'AI_PICK';
}

export function resolveHoldingEntrySource(
  symbol: string,
  asOfDate: string,
  db: DatabaseType,
): PortfolioEntrySource {
  const sym = symbol.toUpperCase();

  const paper = db
    .prepare(
      `
      SELECT source_date AS sourceDate, signal_type AS signalType
      FROM paper_trades
      WHERE symbol = ? AND source_date <= ?
      ORDER BY source_date DESC, id DESC
      LIMIT 1
    `,
    )
    .get(sym, asOfDate) as { sourceDate: string; signalType: PaperTradeSignalType } | undefined;
  if (paper) {
    return resolvePaperEntrySource(sym, paper.sourceDate, paper.signalType, db);
  }

  const screen = db
    .prepare(
      `
      SELECT screen_name AS screenName
      FROM screens
      WHERE symbol = ?
        AND date <= ?
        AND date >= date(?, '-365 days')
        AND screen_name IN ('quality_garp', 'catalyst_entry', 'momentum_mf')
      ORDER BY date DESC
      LIMIT 1
    `,
    )
    .get(sym, asOfDate, asOfDate) as { screenName: string } | undefined;
  if (screen?.screenName === 'quality_garp') return 'quality_garp';
  if (screen?.screenName === 'catalyst_entry') return 'catalyst_entry';
  if (screen?.screenName === 'momentum_mf') return 'momentum_mf';

  const openMom = db
    .prepare(
      `
      SELECT 1
      FROM paper_trades
      WHERE symbol = ? AND status = 'OPEN' AND signal_type = 'momentum_mf'
      LIMIT 1
    `,
    )
    .get(sym);
  if (openMom) return 'momentum_mf';

  const thesis = db
    .prepare(
      `
      SELECT trigger_reason AS triggerReason
      FROM theses
      WHERE symbol = ? AND date <= ?
      ORDER BY date DESC
      LIMIT 1
    `,
    )
    .get(sym, asOfDate) as { triggerReason: string } | undefined;
  if (thesis?.triggerReason) {
    const lower = thesis.triggerReason.toLowerCase();
    for (const name of ['quality_garp', 'catalyst_entry'] as const) {
      if (lower.includes(name)) return name;
    }
    if (lower.includes('momentum')) return 'momentum_mf';
  }

  return 'unknown';
}

export function applyMomentumPortfolioGuardrails(
  action: PortfolioAction,
  signals: Record<string, number>,
  opts: { entrySource?: PortfolioEntrySource | null } = {},
): PortfolioAction {
  const cfg = loadMomentumConfig();
  const rank = signals.mom_rank;
  const exitTh = cfg.exit_rank_threshold;

  if (
    opts.entrySource === 'momentum_mf' &&
    rank != null &&
    Number.isFinite(rank) &&
    rank > exitTh
  ) {
    const severeTh = exitTh + 5;
    const next: 'TRIM' | 'EXIT' = rank > severeTh ? 'EXIT' : 'TRIM';
    const prefix = `GUARDRAIL_OVERRIDE[mom_rank=${rank}>threshold=${exitTh}]`;
    const detail =
      next === 'EXIT'
        ? `[Momentum: severe rank decay ${rank} > ${severeTh} — EXIT.]`
        : `[Momentum: rank decay ${rank} > ${exitTh} — TRIM review before EXIT.]`;
    return escalate(action, next, prefix, detail, next === 'EXIT' ? 0.68 : 0.6);
  }

  const falseFlag = signals.mom_false_flag === 1;
  if (falseFlag && action.action === 'ADD') {
    const suffix = '[Guardrail: mom_false_flag=1 — do not ADD.]';
    return {
      ...action,
      action: 'HOLD',
      conviction: Math.min(action.conviction, 0.55),
      triggerReason: truncateTriggerReason(`${action.triggerReason} ${suffix}`),
    };
  }

  return action;
}

export function qualityGarpDeteriorationFlags(
  fundamentals: QualityGarpFundamentalRow | undefined,
  profitGrowth: number | null,
): string[] {
  if (!fundamentals) return [];
  const flags: string[] = [];
  if (fundamentals.promoterHoldingChangeQoQ != null && fundamentals.promoterHoldingChangeQoQ < 0) {
    flags.push('promoter selling');
  }
  if (profitGrowth != null && profitGrowth < 0) {
    flags.push('profit decline');
  }
  if (fundamentals.debtToEquity != null && fundamentals.debtToEquity >= QUALITY_GARP_DE_MAX) {
    flags.push('leverage breach');
  }
  if (fundamentals.peg != null && fundamentals.peg >= QUALITY_GARP_PEG_MAX) {
    flags.push('PEG stretch');
  }
  if (fundamentals.latestRoe != null && fundamentals.latestRoe < QUALITY_GARP_ROE_MIN) {
    flags.push('ROE below floor');
  }
  if (fundamentals.latestRoce != null && fundamentals.latestRoce < QUALITY_GARP_ROCE_MIN) {
    flags.push('ROCE below floor');
  }
  return flags;
}

/** QG inverse-gate flags for portfolio LLM context (any entry source). */
export function getQualityGarpDeteriorationFlagsForSymbol(
  symbol: string,
  date: string,
  db: DatabaseType,
): string[] {
  return qualityGarpDeteriorationFlags(
    qualityGarpRow(symbol, date, db),
    profitGrowthYoy(symbol, date, db),
  );
}

function applyQualityGarpPortfolioGuardrails(
  action: PortfolioAction,
  ctx: StrategyGuardrailCtx,
): PortfolioAction {
  const applies = ctx.entrySource === 'quality_garp' || ctx.entrySource === 'unknown';
  if (!applies) return action;

  const flags = getQualityGarpDeteriorationFlagsForSymbol(ctx.symbol, ctx.date, ctx.db);
  if (flags.length === 0) return action;

  const strategyKey = ctx.entrySource === 'quality_garp' ? 'quality_garp' : 'universal_qg';
  const severe = flags.includes('promoter selling') && flags.includes('profit decline');

  if (ctx.entrySource === 'quality_garp' && (severe || flags.length >= 4)) {
    const prefix = `GUARDRAIL_OVERRIDE[strategy=${strategyKey},flags=${flags.length}]`;
    const detail = `[Quality-GARP: severe deterioration (${flags.join(', ')}) — EXIT.]`;
    return escalate(action, 'EXIT', prefix, detail, 0.65);
  }
  if (flags.length < 2) return action;

  const prefix = `GUARDRAIL_OVERRIDE[strategy=${strategyKey},flags=${flags.length}]`;
  const detail =
    ctx.entrySource === 'quality_garp'
      ? `[Quality-GARP: fundamental deterioration (${flags.join(', ')}) — TRIM.]`
      : `[Universal QG deterioration (${flags.join(', ')}) — TRIM review; no EXIT from QG alone.]`;
  return escalate(action, 'TRIM', prefix, detail, 0.58);
}

export function applyTechnicalTrimEscalation(
  action: PortfolioAction,
  signals: Record<string, number>,
  pnlPct: number | null | undefined,
): PortfolioAction {
  if (action.action !== 'HOLD') return action;
  const rsi = signals.rsi_14;
  const pctHi = signals.pct_from_52w_high;
  if (rsi == null || pctHi == null || pnlPct == null) return action;
  if (rsi <= 75 || pctHi <= -5 || pnlPct <= 50) return action;

  const prefix = 'GUARDRAIL_OVERRIDE[LITE_ESCALATION]';
  const detail = `[Technical: RSI ${rsi.toFixed(0)} > 75, within 5% of 52W high, unrealised +${pnlPct.toFixed(1)}% — TRIM.]`;
  return escalate(action, 'TRIM', prefix, detail, 0.58);
}

export function applyConcentrationGuardrails(
  action: PortfolioAction,
  weightPct: number | null | undefined,
): PortfolioAction {
  if (weightPct == null || weightPct < HARD_CONCENTRATION_PCT) return action;
  const prefix = `GUARDRAIL_OVERRIDE[concentration=${weightPct.toFixed(1)}%>=${HARD_CONCENTRATION_PCT}%]`;
  const detail = `[Concentration: ${weightPct.toFixed(1)}% of invested book — TRIM review.]`;
  return escalate(action, 'TRIM', prefix, detail, 0.6);
}

function calendarDaysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

function addCalendarDays(isoDate: string, days: number): string {
  const ms = Date.parse(`${isoDate}T00:00:00Z`) + days * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function catalystHoldWindowEnd(
  screenDate: string,
  criteria: { days_to_earnings?: number; expected_earnings_date?: string },
): string | null {
  if (criteria.expected_earnings_date) {
    return addCalendarDays(criteria.expected_earnings_date, 2);
  }
  if (criteria.days_to_earnings != null) {
    return addCalendarDays(screenDate, Math.trunc(criteria.days_to_earnings) + 2);
  }
  return null;
}

function catalystHoldExpired(
  symbol: string,
  asOfDate: string,
  db: DatabaseType,
): { expired: boolean; daysPastMax: number; reason: string | null } {
  const sym = symbol.toUpperCase();

  const open = db
    .prepare(
      `
      SELECT source_date AS sourceDate, max_hold_days AS maxHoldDays
      FROM paper_trades
      WHERE symbol = ? AND signal_type = 'catalyst_entry' AND status = 'OPEN'
      LIMIT 1
    `,
    )
    .get(sym) as { sourceDate: string; maxHoldDays: number } | undefined;

  if (open) {
    const held = calendarDaysBetween(open.sourceDate, asOfDate);
    const past = held - open.maxHoldDays;
    if (past > 0) {
      return {
        expired: true,
        daysPastMax: past,
        reason: `hold ${held}d > max ${open.maxHoldDays}d`,
      };
    }
    return { expired: false, daysPastMax: 0, reason: null };
  }

  const screen = db
    .prepare(
      `
      SELECT date, matched_criteria AS matchedCriteria
      FROM screens
      WHERE symbol = ? AND screen_name = 'catalyst_entry' AND date <= ?
      ORDER BY date DESC
      LIMIT 1
    `,
    )
    .get(sym, asOfDate) as { date: string; matchedCriteria: string } | undefined;

  if (screen?.matchedCriteria) {
    try {
      const parsed = JSON.parse(screen.matchedCriteria) as {
        days_to_earnings?: number;
        expected_earnings_date?: string;
      };
      const windowEnd = catalystHoldWindowEnd(screen.date, parsed);
      if (windowEnd != null && asOfDate > windowEnd) {
        const past = calendarDaysBetween(windowEnd, asOfDate);
        return {
          expired: true,
          daysPastMax: past,
          reason: `post-earnings window ended ${windowEnd}`,
        };
      }
    } catch {
      /* ponytail: malformed criteria → no catalyst exit */
    }
  }

  return { expired: false, daysPastMax: 0, reason: null };
}

function applyCatalystPortfolioGuardrails(
  action: PortfolioAction,
  ctx: StrategyGuardrailCtx,
): PortfolioAction {
  if (ctx.entrySource !== 'catalyst_entry') return action;

  const { expired, daysPastMax, reason } = catalystHoldExpired(ctx.symbol, ctx.date, ctx.db);
  if (!expired || !reason) return action;

  const severe = daysPastMax >= 5 || (ctx.pnlPct != null && ctx.pnlPct < -5);
  const next: 'TRIM' | 'EXIT' = severe ? 'EXIT' : 'TRIM';
  const prefix = `GUARDRAIL_OVERRIDE[strategy=catalyst_entry]`;
  const detail =
    next === 'EXIT'
      ? `[Catalyst: ${reason} — EXIT.]`
      : `[Catalyst: ${reason} — TRIM review before EXIT.]`;
  return escalate(action, next, prefix, detail, next === 'EXIT' ? 0.62 : 0.55);
}

/** Applies momentum → quality-GARP → catalyst → technical TRIM → concentration guardrails. */
export function applyStrategyPortfolioGuardrails(
  action: PortfolioAction,
  signals: Record<string, number>,
  ctx: StrategyGuardrailCtx,
): PortfolioAction {
  let out = applyMomentumPortfolioGuardrails(action, signals, { entrySource: ctx.entrySource });
  out = applyQualityGarpPortfolioGuardrails(out, ctx);
  out = applyCatalystPortfolioGuardrails(out, ctx);
  out = applyTechnicalTrimEscalation(out, signals, ctx.pnlPct);
  if (!ctx.skipConcentration) {
    out = applyConcentrationGuardrails(out, ctx.weightPct);
  }
  return out;
}
