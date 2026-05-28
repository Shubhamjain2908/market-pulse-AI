/**
 * Regime agent: deterministic classification + optional LLM narrative, then upsert `regime_daily`.
 *
 * Risk #4 (spec): we intentionally **do not** maintain a separate `regime_changes` table — `prev_regime`
 * on each `regime_daily` row is sufficient for change detection and avoids duplicated schema.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import {
  type PreparedRegimeDaily,
  prepareRegimeDaily,
  type RunRegimeClassifierOptions,
} from '../analysers/regime-classifier.js';
import { getDb } from '../db/connection.js';
import { insertRegimeRow } from '../db/regime-queries.js';
import { getLlmProvider } from '../llm/index.js';
import type { LlmProvider } from '../llm/types.js';
import { child } from '../logger.js';
import type { Regime, RegimeClassification } from '../types/regime.js';

const log = child({ component: 'regime-agent' });

/**
 * Narrative-only LLM task aligned with spec §6.2. Persisted regime/scores come from
 * `prepareRegimeDaily`; Gemini JSON mode often truncates mid-string — plain text avoids that.
 */
export const REGIME_NARRATIVE_SYSTEM_PROMPT = `You are a market regime analyst for Indian equity markets (NSE/BSE).

You receive JSON with pre-computed signals and deterministic_regime — that label is authoritative.

Write exactly ONE sentence (maximum 25 words) suitable for a morning briefing.
Use plain English; cite concrete numbers from the payload (e.g. VIX, FII 20d ₹ Cr, Nifty vs SMA200).

Output rules:
- Plain text only — no JSON, no markdown, no code fences, no bullet list.
- Do not contradict deterministic_regime.

Context (for wording only; do not re-classify):
- If VIX > 28 OR nifty_gap_pct < -3 the deterministic label would be CRISIS.
- Score bands: >= +8 bull; +2..+7 mild bull; -2..+1 choppy; -7..-3 bear; <= -8 strong bear.
- Persistence may keep an older label until 3 days — mention if regime_age suggests that.`;

/** @deprecated Use REGIME_NARRATIVE_SYSTEM_PROMPT — narrative is plain text, not JSON. */
export const REGIME_SYSTEM_PROMPT = REGIME_NARRATIVE_SYSTEM_PROMPT;

/** Trim fences/quotes models sometimes add around a single sentence. */
export function sanitizeRegimeNarrativeText(raw: string): string {
  let s = raw.trim();
  const fenced = s.match(/^```(?:\w*)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/);
  if (fenced?.[1]) s = fenced[1].trim();
  else if (s.startsWith('```')) {
    s = s
      .replace(/^```(?:\w*)?\s*\r?\n?/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
  }
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

/** Rejects truncated / malformed LLM output (mid-parenthesis, missing terminator) — use templated fallback instead. */
export function isCompleteRegimeNarrative(s: string): boolean {
  const t = s.trim();
  if (t.length < 28) return false;
  if (!/[.!?]$/.test(t)) return false;
  const open = [...t.matchAll(/\(/g)].length;
  const close = [...t.matchAll(/\)/g)].length;
  return open === close;
}

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
  const fiiRaw = prepared.signals.fii20dRollingCr;
  const fii = fiiRaw != null && Number.isFinite(fiiRaw) ? fiiRaw.toFixed(1) : 'n/a';
  return `Regime: ${r.regime}. Score: ${r.scoreTotal.toFixed(1)}. VIX: ${vix}. FII 20d: ₹${fii}Cr.`;
}

/**
 * Signals → deterministic row → optional LLM plain-text narrative → upsert `regime_daily`.
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
      /** Plain sentence — avoids Gemini JSON MIME truncation (mid-string / MAX_TOKENS invalid JSON). */
      const res = await provider.generateText({
        system: REGIME_NARRATIVE_SYSTEM_PROMPT,
        user: JSON.stringify(buildRegimeAgentUserPayload(prepared)),
        temperature: 0.2,
        maxOutputTokens: 160,
      });
      const n = sanitizeRegimeNarrativeText(res.text);
      if (n && isCompleteRegimeNarrative(n)) {
        narrative = n;
        usedFallbackNarrative = false;
      } else if (n && !isCompleteRegimeNarrative(n)) {
        log.warn(
          { preview: n.slice(0, 120) },
          'regime narrative incomplete — using templated fallback',
        );
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      log.error(
        { err: e.message, stack: e.stack },
        'regime narrative LLM failed — using templated fallback',
      );
      console.error('[regime-agent] narrative LLM failed:', e);
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
