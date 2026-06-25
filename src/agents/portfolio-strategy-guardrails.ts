/**
 * Strategy-aware portfolio action guardrails (momentum, quality-GARP, catalyst).
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import {
  QUALITY_GARP_DE_MAX,
  QUALITY_GARP_PEG_MAX,
  QUALITY_GARP_ROCE_MIN,
  QUALITY_GARP_ROE_MIN,
} from '../analysers/quality-garp.js';
import { loadMomentumConfig } from '../config/loaders.js';
import type { QualityGarpFundamentalRow } from '../db/queries.js';
import type { PortfolioAction } from './portfolio-analyser.js';
import type { PortfolioEntrySource } from './portfolio-entry-source.js';

export interface StrategyGuardrailCtx {
  entrySource: PortfolioEntrySource;
  symbol: string;
  date: string;
  db: DatabaseType;
  qualityGarpBySymbol?: Map<string, QualityGarpFundamentalRow>;
  pnlPct?: number | null;
}

function truncateTriggerReason(s: string): string {
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
    if (action.action === 'EXIT') return action;
    const severeTh = exitTh + 5;
    const nextAction: PortfolioAction['action'] = rank > severeTh ? 'EXIT' : 'TRIM';
    if (action.action === nextAction) return action;
    const prefix = `GUARDRAIL_OVERRIDE[mom_rank=${rank}>threshold=${exitTh}]`;
    const suffix =
      nextAction === 'EXIT'
        ? `[Momentum: severe rank decay ${rank} > ${severeTh} — EXIT.]`
        : `[Momentum: rank decay ${rank} > ${exitTh} — TRIM review before EXIT.]`;
    return {
      ...action,
      action: nextAction,
      conviction: Math.max(action.conviction, nextAction === 'EXIT' ? 0.68 : 0.6),
      triggerReason: prependTriggerReason(prefix, `${action.triggerReason} ${suffix}`),
    };
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

export function assessQualityGarpDeterioration(
  fundamentals: QualityGarpFundamentalRow | undefined,
  profitGrowthYoy: number | null,
): string[] {
  if (!fundamentals) return [];
  const flags: string[] = [];
  if (fundamentals.promoterHoldingChangeQoQ != null && fundamentals.promoterHoldingChangeQoQ < 0) {
    flags.push('promoter selling');
  }
  if (profitGrowthYoy != null && profitGrowthYoy < 0) {
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

function getProfitGrowthYoy(symbol: string, db: DatabaseType): number | null {
  const row = db
    .prepare(
      `
      SELECT profit_growth_yoy AS profitGrowthYoy
      FROM fundamentals
      WHERE symbol = ?
      ORDER BY as_of DESC
      LIMIT 1
    `,
    )
    .get(symbol.toUpperCase()) as { profitGrowthYoy: number | null } | undefined;
  return row?.profitGrowthYoy ?? null;
}

export function applyQualityGarpPortfolioGuardrails(
  action: PortfolioAction,
  ctx: StrategyGuardrailCtx,
): PortfolioAction {
  if (ctx.entrySource !== 'quality_garp') return action;

  const fundamentals = ctx.qualityGarpBySymbol?.get(ctx.symbol.toUpperCase());
  const flags = assessQualityGarpDeterioration(
    fundamentals,
    getProfitGrowthYoy(ctx.symbol, ctx.db),
  );
  if (flags.length === 0) return action;

  const severe = flags.includes('promoter selling') && flags.includes('profit decline');
  const next: 'TRIM' | 'EXIT' = severe || flags.length >= 4 ? 'EXIT' : 'TRIM';
  const prefix = `GUARDRAIL_OVERRIDE[strategy=quality_garp,flags=${flags.length}]`;
  const detail =
    next === 'EXIT'
      ? `[Quality-GARP: severe deterioration (${flags.join(', ')}) — EXIT.]`
      : `[Quality-GARP: fundamental deterioration (${flags.join(', ')}) — TRIM.]`;
  return escalate(action, next, prefix, detail, next === 'EXIT' ? 0.65 : 0.58);
}

function calendarDaysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

export function assessCatalystHoldExpired(
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
      SELECT matched_criteria AS matchedCriteria
      FROM screens
      WHERE symbol = ? AND screen_name = 'catalyst_entry' AND date <= ?
      ORDER BY date DESC
      LIMIT 1
    `,
    )
    .get(sym, asOfDate) as { matchedCriteria: string } | undefined;

  if (screen?.matchedCriteria) {
    try {
      const parsed = JSON.parse(screen.matchedCriteria) as { days_to_earnings?: number };
      const dte = parsed.days_to_earnings;
      if (dte != null && dte < -2) {
        return {
          expired: true,
          daysPastMax: Math.abs(dte) - 2,
          reason: `post-earnings window (days_to_earnings=${dte})`,
        };
      }
    } catch {
      /* ponytail: malformed criteria → no catalyst exit */
    }
  }

  return { expired: false, daysPastMax: 0, reason: null };
}

export function applyCatalystPortfolioGuardrails(
  action: PortfolioAction,
  ctx: StrategyGuardrailCtx,
): PortfolioAction {
  if (ctx.entrySource !== 'catalyst_entry') return action;

  const { expired, daysPastMax, reason } = assessCatalystHoldExpired(ctx.symbol, ctx.date, ctx.db);
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

/** Applies momentum → quality-GARP → catalyst guardrails in order. */
export function applyStrategyPortfolioGuardrails(
  action: PortfolioAction,
  signals: Record<string, number>,
  ctx: StrategyGuardrailCtx,
): PortfolioAction {
  let out = applyMomentumPortfolioGuardrails(action, signals, { entrySource: ctx.entrySource });
  out = applyQualityGarpPortfolioGuardrails(out, ctx);
  out = applyCatalystPortfolioGuardrails(out, ctx);
  return out;
}
