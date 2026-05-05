/**
 * Regime agent: deterministic classification + optional LLM narrative, then upsert `regime_daily`.
 *
 * Risk #4 (spec): we intentionally **do not** maintain a separate `regime_changes` table — `prev_regime`
 * on each `regime_daily` row is sufficient for change detection and avoids duplicated schema.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { z } from 'zod';
import {
  type PreparedRegimeDaily,
  type RunRegimeClassifierOptions,
  prepareRegimeDaily,
} from '../analysers/regime-classifier.js';
import { getDb } from '../db/connection.js';
import { insertRegimeRow } from '../db/regime-queries.js';
import { getLlmProvider } from '../llm/index.js';
import { parseAndValidate } from '../llm/json.js';
import type { LlmProvider } from '../llm/types.js';
import { type Regime, type RegimeClassification, RegimeSchema } from '../types/regime.js';

/**
 * Verbatim from product spec §6.2 (Market Regime Filter).
 */
export const REGIME_SYSTEM_PROMPT = `You are a market regime classifier for Indian equity markets (NSE/BSE).

You receive pre-computed signal values and must:

1. Output ONE of four regime labels: BULL_TRENDING, BEAR_TRENDING, CHOPPY, CRISIS
2. Write a single sentence (max 25 words) explaining the classification.
   Use plain English. Name specific values. E.g.:
   'FII sold ₹8,200 Cr over 20 days with Nifty below SMA200 and VIX at 22 — bear regime.'

Rules:
- If VIX > 28 OR nifty_gap_pct < -3: regime MUST be CRISIS regardless of other signals.
- Base classification on total_score using these bands:
  >= +8  → BULL_TRENDING
  +2 to +7 → BULL_TRENDING (mild)
  -2 to +1 → CHOPPY
  -7 to -3 → BEAR_TRENDING
  <= -8  → BEAR_TRENDING (strong)
- Apply persistence: if score changed regime but history shows < 3 days of new regime,
  revert to previous regime and note it in narrative.

Return ONLY valid JSON matching this schema — no markdown, no fences:
{
  "regime": string,
  "narrative": string,
  "crisis_override": boolean,
  "confidence": number
}`;

export const RegimeLlmResponseSchema = z.object({
  regime: RegimeSchema,
  narrative: z.string(),
  crisis_override: z.boolean(),
  confidence: z.number().min(0).max(1),
});

export interface RunRegimeAgentOptions extends RunRegimeClassifierOptions {
  /** When true, skip the LLM call and use the templated fallback narrative only. */
  skipLlm?: boolean;
}

export interface RunRegimeAgentResult {
  sessionDate: string;
  regime: Regime;
  narrative: string;
  /** True when persisted `regime` differs from `prev_regime` on the row (yesterday's label). */
  changed: boolean;
  usedFallbackNarrative: boolean;
  classification: RegimeClassification;
}

export function buildRegimeAgentUserPayload(
  prepared: PreparedRegimeDaily,
): Record<string, unknown> {
  const { signals, classification, sessionDate } = prepared;
  return {
    date: sessionDate,
    deterministic_regime: classification.regime,
    score_total: signals.scoreTotal,
    score_breakdown: classification.scoreBreakdown,
    signals: {
      nifty_vs_sma200_pct: signals.niftyVsSma200Pct,
      sma200_slope_10d_pct: signals.sma200Slope10dPct,
      vix_current: signals.vixCurrent,
      vix_5d_change_pct: signals.vix5dChangePct,
      fii_20d_rolling_cr: signals.fii20dRollingCr,
      fii_5d_trend: signals.fii5dTrend,
      ad_ratio: signals.adRatio,
      pct_nse500_above_sma200: signals.pctAboveSma200,
      nifty_gap_pct: signals.niftyGapPct,
    },
    prev_regime: classification.prevRegime,
    regime_age: classification.regimeAge,
  };
}

export function buildFallbackNarrative(prepared: PreparedRegimeDaily): string {
  const r = prepared.insertRow;
  const vix = r.vixValue.toFixed(2);
  const fii = r.fii20dNet.toFixed(1);
  return `Regime: ${r.regime}. Score: ${r.scoreTotal.toFixed(1)}. VIX: ${vix}. FII 20d: ₹${fii}Cr.`;
}

/**
 * Signals → deterministic row → optional LLM JSON narrative → upsert `regime_daily`.
 * Persisted scores/regime are always from `prepareRegimeDaily`; the LLM supplies narrative only.
 */
export async function runRegimeAgent(
  opts: RunRegimeAgentOptions = {},
  db: DatabaseType = getDb(),
  llm?: LlmProvider,
): Promise<RunRegimeAgentResult> {
  const prepared = prepareRegimeDaily(opts, db);
  const { classification, insertRow } = prepared;

  const changed =
    classification.prevRegime != null && classification.prevRegime !== classification.regime;

  let narrative = buildFallbackNarrative(prepared);
  let usedFallbackNarrative = true;

  if (!opts.skipLlm) {
    try {
      const provider = llm ?? getLlmProvider();
      const res = await provider.generateText({
        system: REGIME_SYSTEM_PROMPT,
        user: JSON.stringify(buildRegimeAgentUserPayload(prepared)),
        temperature: 0.2,
        maxOutputTokens: 256,
      });
      const parsed = parseAndValidate(res.text, RegimeLlmResponseSchema);
      const n = parsed.narrative?.trim();
      if (n) {
        narrative = n;
        usedFallbackNarrative = false;
      }
    } catch {
      // LLM or parse failure — keep templated narrative; row write still proceeds.
    }
  }

  insertRegimeRow({ ...insertRow, narrative }, db);

  return {
    sessionDate: prepared.sessionDate,
    regime: classification.regime,
    narrative,
    changed,
    usedFallbackNarrative,
    classification,
  };
}
