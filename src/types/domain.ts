/**
 * Core domain types shared across ingestors, enrichers, analysers and the
 * briefing composer. Keep these provider-agnostic - a `RawQuote` from NSE
 * should be indistinguishable from one returned by Kite once normalised.
 */

import { z } from 'zod';
import { RegimeSchema } from './regime.js';

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export const RawQuoteSchema = z.object({
  symbol: z.string(),
  exchange: z.enum(['NSE', 'BSE']).default('NSE'),
  /** ISO-8601 date string, IST trading day (YYYY-MM-DD). */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  /** Adjusted close, when available. Falls back to `close`. */
  adjClose: z.number().optional(),
  volume: z.number().int().nonnegative(),
  source: z.string(),
});
export type RawQuote = z.infer<typeof RawQuoteSchema>;

// ---------------------------------------------------------------------------
// Fundamentals
// ---------------------------------------------------------------------------

export const FundamentalsSchema = z.object({
  symbol: z.string(),
  asOf: z.string(),
  marketCap: z.number().optional(),
  pe: z.number().optional(),
  pb: z.number().optional(),
  peg: z.number().optional(),
  roe: z.number().optional(),
  roce: z.number().optional(),
  revenueGrowthYoY: z.number().optional(),
  profitGrowthYoY: z.number().optional(),
  /** TTM net profit in crores; negative = loss-making. */
  netProfitTtm: z.number().optional(),
  debtToEquity: z.number().optional(),
  promoterHoldingPct: z.number().optional(),
  promoterHoldingChangeQoQ: z.number().optional(),
  dividendYield: z.number().optional(),
  source: z.string(),
});
export type Fundamentals = z.infer<typeof FundamentalsSchema>;

// ---------------------------------------------------------------------------
// Quarterly Fundamentals (from Screener.in quarterly tables)
// ---------------------------------------------------------------------------

export const QuarterlyFundamentalsSchema = z.object({
  symbol: z.string(),
  /** Quarter-end date (YYYY-MM-DD), e.g. 2025-12-31 for Dec 2025 quarter. */
  quarterEnd: z.string(),
  /** Total revenue / sales for the quarter, in ₹ crores. */
  revenue: z.number().optional(),
  /** Operating profit for the quarter, in ₹ crores. */
  operatingProfit: z.number().optional(),
  /** Operating profit margin (OPM as percentage, e.g. 28.0 for 28%). */
  opmPct: z.number().optional(),
  /** Net profit / net income for the quarter, in ₹ crores. */
  netProfit: z.number().optional(),
  /** Earnings per share (diluted or basic as reported), in ₹. */
  eps: z.number().optional(),
  /** Operating cash flow for the quarter, in ₹ crores. */
  operatingCashFlow: z.number().optional(),
  /** Free cash flow for the quarter, in ₹ crores. */
  freeCashFlow: z.number().optional(),
  source: z.string(),
});
export type QuarterlyFundamentals = z.infer<typeof QuarterlyFundamentalsSchema>;

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

export const NewsItemSchema = z.object({
  /** Stock symbol if the article is unambiguously about one company. */
  symbol: z.string().optional(),
  headline: z.string(),
  summary: z.string().optional(),
  source: z.string(),
  url: z.string().url(),
  publishedAt: z.string(),
  /** Sentiment scored later by the enricher; -1 (very bearish) to 1 (very bullish). */
  sentiment: z.number().min(-1).max(1).optional(),
});
export type NewsItem = z.infer<typeof NewsItemSchema>;

// ---------------------------------------------------------------------------
// FII / DII activity
// ---------------------------------------------------------------------------

export const FiiDiiRowSchema = z.object({
  date: z.string(),
  segment: z.enum(['cash', 'fno', 'fno_index_fut', 'fno_stock_fut']),
  fiiBuy: z.number(),
  fiiSell: z.number(),
  fiiNet: z.number(),
  diiBuy: z.number(),
  diiSell: z.number(),
  diiNet: z.number(),
  source: z.string(),
});
export type FiiDiiRow = z.infer<typeof FiiDiiRowSchema>;

// ---------------------------------------------------------------------------
// Signals (output of Enricher stage)
// ---------------------------------------------------------------------------

export const SignalSchema = z.object({
  symbol: z.string(),
  date: z.string(),
  /** e.g. 'sma_20', 'rsi_14', 'volume_ratio_20d', 'pct_from_52w_high' */
  name: z.string(),
  value: z.number(),
  /** Stage that produced the signal - useful for invalidation. */
  source: z.enum(['technical', 'fundamental', 'sentiment', 'flow', 'momentum', 'momentum_ranker']),
});
export type Signal = z.infer<typeof SignalSchema>;

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

export const ScreenOperatorSchema = z.enum([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  /** Compare a signal against another signal, e.g. close > sma_50. */
  'gt_signal',
  'lt_signal',
]);
export type ScreenOperator = z.infer<typeof ScreenOperatorSchema>;

export const ScreenCriterionSchema = z.object({
  signal: z.string(),
  op: ScreenOperatorSchema,
  value: z.union([z.number(), z.string(), z.tuple([z.number(), z.number()])]),
});
export type ScreenCriterion = z.infer<typeof ScreenCriterionSchema>;

export const ScreenDefinitionSchema = z.object({
  name: z.string(),
  label: z.string(),
  description: z.string(),
  timeHorizon: z.enum(['short', 'medium', 'long']),
  criteria: z.array(ScreenCriterionSchema).min(1),
});
export type ScreenDefinition = z.infer<typeof ScreenDefinitionSchema>;

/** Persisted inside `screens.matched_criteria` JSON under `__regime_meta` when regime gating is active. */
export const RegimeScreenMetaSchema = z.object({
  regime: RegimeSchema,
  sizeMultiplier: z.number(),
  strategyId: z.string(),
});
export type RegimeScreenMeta = z.infer<typeof RegimeScreenMetaSchema>;

export const ScreenMatchedCriteriaStoredSchema = z.union([
  z.array(ScreenCriterionSchema),
  z.object({
    criteria: z.array(ScreenCriterionSchema),
    __regime_meta: RegimeScreenMetaSchema,
  }),
  z.record(z.string(), z.unknown()),
]);
export type ScreenMatchedCriteriaStored = z.infer<typeof ScreenMatchedCriteriaStoredSchema>;

export const ScreenResultSchema = z.object({
  symbol: z.string(),
  date: z.string(),
  screenName: z.string(),
  score: z.number(),
  matchedCriteria: ScreenMatchedCriteriaStoredSchema,
});
export type ScreenResult = z.infer<typeof ScreenResultSchema>;

// ---------------------------------------------------------------------------
// AI thesis (output of LLM)
// ---------------------------------------------------------------------------

/** LLMs often return INR levels as numbers or `{low,high}`; normalize to display strings. */
function thesisInrTextField() {
  return z.preprocess((v: unknown) => {
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return `₹${v}`;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (typeof o.low === 'number' && typeof o.high === 'number') return `₹${o.low}–₹${o.high}`;
      if (typeof o.min === 'number' && typeof o.max === 'number') return `₹${o.min}–₹${o.max}`;
    }
    return v;
  }, z.string().min(1));
}

/** Bull/bear sometimes arrive as one string instead of a string array. */
function thesisBulletList() {
  return z.preprocess((v: unknown) => {
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    if (typeof v === 'string' && v.trim()) return [v.trim()];
    return v;
  }, z.array(z.string()).min(1).max(5));
}

/** LLMs often return prose ("1-3 Months") instead of enum tokens. */
function thesisTimeHorizon() {
  return z.preprocess(
    (v: unknown) => {
      if (v === 'short' || v === 'medium' || v === 'long') return v;
      const s = String(v).toLowerCase();
      if (/(year|12\s*[-–]?\s*month|long[-\s]term|^long$)/i.test(s)) return 'long';
      if (/(1[-–]?\s*3|1[-–]?\s*4\s*month|month|quarter|medium)/i.test(s)) return 'medium';
      if (/(week|1[-–]?\s*4\s*week|^short$)/i.test(s)) return 'short';
      return v;
    },
    z.enum(['short', 'medium', 'long']),
  );
}

export const ThesisSchema = z.object({
  symbol: z.string(),
  thesis: z.string().min(20),
  bullCase: thesisBulletList(),
  bearCase: thesisBulletList(),
  entryZone: thesisInrTextField(),
  stopLoss: thesisInrTextField(),
  target: thesisInrTextField(),
  timeHorizon: thesisTimeHorizon(),
  confidenceScore: z.coerce.number().int().min(1).max(10),
  triggerScreen: z.string(),
  /**
   * LLM-scored qualitative rubric dimensions (0–10 each).
   * Added by Task A rubric. Score ONLY from the provided context;
   * if no evidence, score 4 (neutral) and say so.
   */
  rubric: z
    .object({
      moat: z.coerce.number().int().min(0).max(10),
      sectorTailwind: z.coerce.number().int().min(0).max(10),
      competitivePosition: z.coerce.number().int().min(0).max(10),
      newsCatalyst: z.coerce.number().int().min(0).max(10),
    })
    .optional(),
});
export type Thesis = z.infer<typeof ThesisSchema>;

// ---------------------------------------------------------------------------
// Thesis rubric JSON (stored in theses.rubric_json)
// ---------------------------------------------------------------------------

/** Schema for the full rubric JSON persisted to `theses.rubric_json`. */
export const RubricJsonSchema = z.object({
  /** Deterministic anchors computed from DB data. */
  anchors: z.object({
    earningsTrajectory: z.number().nullable(),
    balanceSheet: z.number().nullable(),
    technicalStage: z.number().nullable(),
  }),
  /** LLM-scored qualitative dimensions. */
  llm: z
    .object({
      moat: z.number(),
      sectorTailwind: z.number(),
      competitivePosition: z.number(),
      newsCatalyst: z.number(),
    })
    .nullable(),
  /** Composite total on 0–90 scale. */
  total: z.number(),
});
export type RubricJson = z.infer<typeof RubricJsonSchema>;

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

export const HoldingSchema = z.object({
  symbol: z.string(),
  qty: z.number().nonnegative(),
  avgPrice: z.number().nonnegative(),
  stopLoss: z.number().nonnegative().optional(),
  target: z.number().nonnegative().optional(),
  notes: z.string().optional(),
});
export type Holding = z.infer<typeof HoldingSchema>;

export const PortfolioSchema = z.object({
  currency: z.literal('INR'),
  totalCapital: z.number().nonnegative(),
  holdings: z.array(HoldingSchema),
});
export type Portfolio = z.infer<typeof PortfolioSchema>;
