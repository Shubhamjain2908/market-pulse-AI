/**
 * Core domain types shared across ingestors, enrichers, analysers and the
 * briefing composer. Keep these provider-agnostic - a `RawQuote` from NSE
 * should be indistinguishable from one returned by Kite once normalised.
 */

import { z } from 'zod';

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
  debtToEquity: z.number().optional(),
  promoterHoldingPct: z.number().optional(),
  promoterHoldingChangeQoQ: z.number().optional(),
  dividendYield: z.number().optional(),
  source: z.string(),
});
export type Fundamentals = z.infer<typeof FundamentalsSchema>;

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
  source: z.enum(['technical', 'fundamental', 'sentiment', 'flow']),
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

export const ScreenResultSchema = z.object({
  symbol: z.string(),
  date: z.string(),
  screenName: z.string(),
  score: z.number(),
  matchedCriteria: z.array(ScreenCriterionSchema),
});
export type ScreenResult = z.infer<typeof ScreenResultSchema>;

// ---------------------------------------------------------------------------
// AI thesis (output of LLM)
// ---------------------------------------------------------------------------

export const ThesisSchema = z.object({
  symbol: z.string(),
  thesis: z.string().min(20),
  bullCase: z.array(z.string()).min(1).max(5),
  bearCase: z.array(z.string()).min(1).max(5),
  entryZone: z.string(),
  stopLoss: z.string(),
  target: z.string(),
  timeHorizon: z.enum(['short', 'medium', 'long']),
  confidenceScore: z.number().int().min(1).max(10),
  triggerScreen: z.string(),
});
export type Thesis = z.infer<typeof ThesisSchema>;

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
