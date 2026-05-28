/**
 * Market regime filter — types + Zod schemas for SQLite rows and signal payloads.
 */

import { z } from 'zod';

export const RegimeSchema = z.enum(['BULL_TRENDING', 'BEAR_TRENDING', 'CHOPPY', 'CRISIS']);
export type Regime = z.infer<typeof RegimeSchema>;

export const Fii5dTrendSchema = z.enum([
  'TURNING_POSITIVE',
  'POSITIVE',
  'MIXED',
  'NEGATIVE',
  'TURNING_NEGATIVE',
]);
export type Fii5dTrend = z.infer<typeof Fii5dTrendSchema>;

/** One row in `regime_daily` (matches migration 0006). */
export const RegimeRowSchema = z.object({
  id: z.number().int().positive().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  regime: RegimeSchema,
  scoreTotal: z.number(),
  scoreTrend: z.number(),
  scoreVix: z.number(),
  scoreFii: z.number(),
  scoreBreadth: z.number(),
  vixValue: z.number().nullable(),
  niftyVsSma200: z.number().nullable(),
  fii20dNet: z.number().nullable(),
  adRatio: z.number().nullable(),
  pctAboveSma200: z.number().nullable(),
  crisisOverride: z.boolean(),
  narrative: z.string().nullable(),
  prevRegime: RegimeSchema.nullable(),
  regimeAge: z.number().int().nonnegative(),
  createdAt: z.string().optional(),
});
export type RegimeRow = z.infer<typeof RegimeRowSchema>;

/** Seed / gate row for `regime_strategy_gate`. */
export const StrategyGateRowSchema = z.object({
  strategyId: z.string().min(1),
  regime: RegimeSchema,
  allowed: z.boolean(),
  sizeMultiplier: z.number(),
  notes: z.string().nullish(),
});
export type StrategyGateRow = z.infer<typeof StrategyGateRowSchema>;

export const StrategyGatesFileSchema = z.object({
  description: z.string().optional(),
  meta: z
    .object({
      futureStrategies: z.array(z.string()).optional(),
    })
    .optional(),
  rows: z.array(StrategyGateRowSchema).min(1),
});
export type StrategyGatesFile = z.infer<typeof StrategyGatesFileSchema>;

/** Output of `computeRegimeSignals` — raw inputs + score breakdown. */
export const RegimeSignalsSchema = z.object({
  date: z.string(),
  niftyVsSma200Pct: z.number().nullable(),
  sma200Slope10dPct: z.number().nullable(),
  vixCurrent: z.number().nullable(),
  vix5dChangePct: z.number().nullable(),
  fii20dRollingCr: z.number().nullable(),
  fii5dTrend: Fii5dTrendSchema,
  adRatio: z.number().nullable(),
  pctAboveSma200: z.number().nullable(),
  niftyGapPct: z.number().nullable(),
  scoreNiftySma: z.number(),
  scoreSma200Slope: z.number(),
  scoreVixLevel: z.number(),
  scoreVix5d: z.number(),
  scoreFii20d: z.number(),
  scoreFii5dTrend: z.number(),
  scoreAdRatio: z.number(),
  scorePctAboveSma200: z.number(),
  scoreTrend: z.number(),
  scoreVix: z.number(),
  scoreFii: z.number(),
  scoreBreadth: z.number(),
  scoreTotal: z.number(),
  warnings: z.array(z.string()),
});
export type RegimeSignals = z.infer<typeof RegimeSignalsSchema>;

/** Deterministic classification outcome (before optional LLM narrative in Phase 3). */
export interface RegimeClassification {
  regime: Regime;
  /** Raw label from score + crisis override (same as `computeRawRegime`). */
  rawRegime: Regime;
  crisisOverride: boolean;
  regimeAge: number;
  prevRegime: Regime | null;
  scoreBreakdown: {
    trend: number;
    vix: number;
    fii: number;
    breadth: number;
  };
}
