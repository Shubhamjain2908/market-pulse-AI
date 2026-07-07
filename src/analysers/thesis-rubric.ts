/**
 * Deterministic anchor scores for the AI_PICK confidence rubric.
 *
 * Quantitative sub-scores computed *deterministically from the DB* — these are
 * the reproducible component of the rubric. Qualitative dimensions (moat,
 * sector tailwind, etc.) are scored by the LLM against written anchors in
 * the thesis prompt.
 *
 * @see Task A of spec/devin-parity-review.md
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { getLatestSignalsMap } from '../agents/portfolio-trigger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ValuationBasis = 'pe_percentile' | 'peg' | null;

export interface RubricAnchors {
  /** Earnings trajectory from quarterly_fundamentals PAT YoY. 0–10, null when < 2 quarters available. */
  earningsTrajectory: number | null;
  /** Balance sheet from D/E and ROE. 0–10, null when D/E or ROE missing. */
  balanceSheet: number | null;
  /** Weinstein stage score from signals (already 0/8/15/25/30 → mapped to 0–30). Null if absent or code = 0. */
  technicalStage: number | null;
  /** Valuation percentile vs own trailing P/E history. 0–10, null when insufficient data and no PEG fallback. */
  valuation: number | null;
  /** Which valuation path was used — recorded for calibration. */
  valuationBasis: ValuationBasis;
}

// ---------------------------------------------------------------------------
// Valuation: percentile rank vs own trailing P/E (Rec 2)
// ---------------------------------------------------------------------------

interface PeRow {
  asOf: string;
  pe: number;
}

/**
 * PEG-only fallback path: score valuation from PEG ratio.
 * Called when P/E percentile path is unavailable.
 */
function pegFallback(
  symbol: string,
  date: string,
  db: DatabaseType,
): { score: number | null; basis: ValuationBasis } {
  const pegRow = db
    .prepare(
      `SELECT peg
       FROM fundamentals
       WHERE symbol = ? AND as_of <= ? AND peg IS NOT NULL AND peg > 0
       ORDER BY as_of DESC
       LIMIT 1`,
    )
    .get(symbol, date) as { peg: number } | undefined;

  if (pegRow && Number.isFinite(pegRow.peg) && pegRow.peg > 0) {
    const peg = pegRow.peg;
    let score: number;
    if (peg <= 1) score = 8;
    else if (peg <= 2) score = 5;
    else score = 2;
    return { score, basis: 'peg' };
  }

  return { score: null, basis: null };
}

/**
 * Score valuation on a 0–10 scale using percentile rank vs own trailing P/E.
 *
 * 1. Fetch the genuinely latest fundamentals row (unfiltered P/E). If that row's
 *    P/E is null/negative/non-finite → PEG/null fallback immediately. This
 *    prevents scoring a newly loss-making company on a months-old positive P/E.
 * 2. Only if current P/E is valid, fetch history for percentile computation.
 * 3. History sufficiency: ≥ 8 distinct rows AND span ≥ 180 days → use P/E percentile.
 * 4. `pct` = fraction of historical values < current P/E (strict less-than; current row included).
 * 5. Score bands:
 *    ≤ 0.10 → 10, ≤ 0.25 → 8, ≤ 0.50 → 6, ≤ 0.75 → 4, ≤ 0.90 → 2, > 0.90 → 0
 *
 * Fallback (when P/E path unavailable):
 *   1. Try PEG from latest fundamentals with finite `peg > 0`: ≤ 1 → 8, ≤ 2 → 5, > 2 → 2.
 *   2. Else → null.
 *
 * Returns { score, basis } where basis records the path taken.
 */
function scoreValuation(
  symbol: string,
  date: string,
  db: DatabaseType,
): { score: number | null; basis: ValuationBasis } {
  const sym = symbol.toUpperCase();

  // Step 1: Fetch the genuinely latest P/E (unfiltered — includes null/negative rows)
  const latestRow = db
    .prepare(
      `SELECT pe
       FROM fundamentals
       WHERE symbol = ? AND as_of <= ?
       ORDER BY as_of DESC
       LIMIT 1`,
    )
    .get(sym, date) as { pe: number | null } | undefined;

  // Step 2: If latest P/E is not valid → fallback (stale/null/negative P/E guard)
  if (!latestRow || latestRow.pe == null || !Number.isFinite(latestRow.pe) || latestRow.pe <= 0) {
    return pegFallback(sym, date, db);
  }

  const currentPe = latestRow.pe;

  // Step 3: Fetch P/E history for percentile (only valid positive values)
  const peRows = db
    .prepare(
      `SELECT as_of AS asOf, pe
       FROM fundamentals
       WHERE symbol = ? AND as_of <= ? AND as_of >= date(?, '-3 years')
         AND pe IS NOT NULL AND pe > 0
       ORDER BY as_of ASC`,
    )
    .all(sym, date, date) as PeRow[];

  // Step 4: History sufficiency — must have >= 8 rows AND >= 180 day span
  if (peRows.length < 8) {
    return pegFallback(sym, date, db);
  }

  const first = peRows[0];
  const last = peRows[peRows.length - 1];
  if (!first || !last) {
    return pegFallback(sym, date, db);
  }

  const spanMs = new Date(last.asOf).getTime() - new Date(first.asOf).getTime();
  const spanDays = spanMs / (1000 * 60 * 60 * 24);
  if (spanDays < 180) {
    return pegFallback(sym, date, db);
  }

  // Step 5: Percentile = fraction of values < current P/E (strict less-than)
  const countBelow = peRows.filter((r) => r.pe < currentPe).length;
  const total = peRows.length;
  const pct = total > 0 ? countBelow / total : 0;

  let score: number;
  if (pct <= 0.1) score = 10;
  else if (pct <= 0.25) score = 8;
  else if (pct <= 0.5) score = 6;
  else if (pct <= 0.75) score = 4;
  else if (pct <= 0.9) score = 2;
  else score = 0;

  return { score, basis: 'pe_percentile' };
}

// ---------------------------------------------------------------------------
// Earnings trajectory (from quarterly_fundamentals)
// ---------------------------------------------------------------------------

interface QfRow {
  quarterEnd: string;
  netProfit: number | null;
}

/**
 * Compute PAT YoY growth for each available quarter pair (T vs T-4).
 * Returns an array of { positive: boolean, value: number } ordered newest-first.
 * Returns empty array when fewer than 5 quarters of data exist (need T and T-4).
 */
function computePatYoYGrowths(rows: QfRow[]): Array<{ positive: boolean; value: number }> {
  if (rows.length < 5) return [];

  const growths: Array<{ positive: boolean; value: number }> = [];
  for (let i = 0; i <= rows.length - 5; i++) {
    const current = rows[i]?.netProfit;
    const prior = rows[i + 4]?.netProfit;
    if (
      current == null ||
      prior == null ||
      !Number.isFinite(current) ||
      !Number.isFinite(prior) ||
      prior === 0
    ) {
      continue;
    }
    const yoy = ((current - prior) / Math.abs(prior)) * 100;
    growths.push({ positive: yoy > 0, value: yoy });
  }
  return growths;
}

/**
 * Score earnings trajectory 0–10 from PAT YoY growths over last 4 quarters.
 *
 * Bands:
 *   4 quarters all positive with sustained acceleration → 10
 *   3 quarters positive → 8
 *   2 quarters positive → 5
 *   0-1 positive with no declining streaks → 3
 *   2+ consecutive declines → 1
 *   3+ consecutive declines → 0
 *   null when < 2 quarters of data
 */
function scoreEarningsTrajectory(
  growths: Array<{ positive: boolean; value: number }>,
): number | null {
  if (growths.length < 2) return null;

  // Use the most recent up-to-4 growths
  const recent = growths.slice(0, 4);
  const positiveCount = recent.filter((g) => g.positive).length;

  // Check for consecutive declines
  let maxConsecutiveDeclines = 0;
  let currentStreak = 0;
  for (const g of recent) {
    if (!g.positive) {
      currentStreak++;
      maxConsecutiveDeclines = Math.max(maxConsecutiveDeclines, currentStreak);
    } else {
      currentStreak = 0;
    }
  }

  // Check for acceleration (each newer growth >= the prior one — growths are newest-first)
  const isAccelerating =
    recent.length >= 2 &&
    recent.every((g, i) => {
      if (i === 0) return true;
      return (recent[i - 1]?.value ?? 0) >= g.value;
    });

  if (positiveCount >= 4 && isAccelerating) return 10;
  if (positiveCount >= 3) return 8;
  if (positiveCount >= 2) return 5;
  if (maxConsecutiveDeclines >= 3) return 0;
  if (maxConsecutiveDeclines >= 2) return 1;
  return 3; // flat / mostly flat
}

// ---------------------------------------------------------------------------
// Balance sheet (from latest fundamentals row)
// ---------------------------------------------------------------------------

/**
 * Score balance sheet health 0–10 from D/E and ROE.
 *
 * Bands:
 *   D/E < 0.3 AND ROE > 20 → 10
 *   D/E < 0.5 AND ROE > 15 → 8
 *   D/E < 1.0            → 6
 *   D/E >= 1.0           → 2
 *   D/E >= 2.0           → 0
 *   null when D/E or ROE missing
 */
function scoreBalanceSheet(de: number | null, roe: number | null): number | null {
  if (de == null || roe == null) return null;
  if (!Number.isFinite(de) || !Number.isFinite(roe)) return null;

  if (de < 0.3 && roe > 20) return 10;
  if (de < 0.5 && roe > 15) return 8;
  if (de < 1.0) return 6;
  if (de >= 2.0) return 0;
  return 2; // D/E between 1.0 and 2.0
}

// ---------------------------------------------------------------------------
// Technical stage (from weinstein_stage_score signal)
// ---------------------------------------------------------------------------

/**
 * Score Weinstein stage 0–30 (reusing existing signal).
 *
 * The `weinstein_stage_score` signal is already emitted by the technical enricher:
 *   0  → Stage 4 (declining)
 *   8  → Stage 1 or 3 (base/distribution)
 *   15 → Stage 1 (insufficient data — map to neutral)
 *   25 → Stage 2A (early uptrend)
 *   30 → Stage 2B (established uptrend)
 *
 * We return the raw score when present and stage_code != 0 (INSUFFICIENT),
 * null otherwise.
 */
function scoreTechnicalStage(signals: Record<string, number>): number | null {
  const score = signals.weinstein_stage_score;
  const code = signals.weinstein_stage_code;

  if (score == null || !Number.isFinite(score)) return null;
  if (code === 0) return null; // INSUFFICIENT data

  return score;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute deterministic rubric anchors for a symbol as of a given date.
 *
 * Returns `null` for each dimension when insufficient data exists — the caller
 * should neutral-weight nulls (4 for 0–10 dimensions, 15 for 0–30 dimension)
 * when computing the composite total.
 *
 * @param symbol - Stock symbol (case-insensitive)
 * @param date   - ISO date string (YYYY-MM-DD)
 * @param db     - SQLite database handle
 */
export function computeRubricAnchors(
  symbol: string,
  date: string,
  db: DatabaseType,
): RubricAnchors {
  const sym = symbol.toUpperCase();

  // ---- Valuation ----
  const { score: valuation, basis: valuationBasis } = scoreValuation(sym, date, db);

  // ---- Earnings trajectory ----
  const qfRows = db
    .prepare(
      `SELECT quarter_end AS quarterEnd, net_profit AS netProfit
       FROM quarterly_fundamentals
       WHERE symbol = ? AND quarter_end <= ?
       ORDER BY quarter_end DESC
       LIMIT 10`,
    )
    .all(sym, date) as QfRow[];

  const growths = computePatYoYGrowths(qfRows);
  const earningsTrajectory = scoreEarningsTrajectory(growths);

  // ---- Balance sheet ----
  const fundRow = db
    .prepare(
      `SELECT debt_to_equity AS de, roe
       FROM fundamentals
       WHERE symbol = ? AND as_of <= ?
       ORDER BY as_of DESC
       LIMIT 1`,
    )
    .get(sym, date) as { de: number | null; roe: number | null } | undefined;

  let de: number | null = null;
  let roe: number | null = null;
  if (fundRow) {
    de = fundRow.de != null && Number.isFinite(fundRow.de) ? fundRow.de : null;
    roe = fundRow.roe != null && Number.isFinite(fundRow.roe) ? fundRow.roe : null;
  }
  const balanceSheet = scoreBalanceSheet(de, roe);

  // ---- Technical stage ----
  const signals = getLatestSignalsMap(sym, date, db);
  const technicalStage = scoreTechnicalStage(signals);

  return { earningsTrajectory, balanceSheet, technicalStage, valuation, valuationBasis };
}

/**
 * Compute the composite rubric total on a 0–100 scale.
 *
 * Formula:
 *   earningsTrajectory (0–10, null→4)
 *   + balanceSheet (0–10, null→4)
 *   + valuation (0–10, null→4)
 *   + moat (0–10, null→4)
 *   + sectorTailwind (0–10, null→4)
 *   + competitivePosition (0–10, null→4)
 *   + newsCatalyst (0–10, null→4)
 *   = 0–70 subtotal
 *   + technicalStage (0–30, null→15)
 *   = 0–100 total
 */
export function computeRubricTotal(
  anchors: RubricAnchors,
  llmRubric: {
    moat?: number;
    sectorTailwind?: number;
    competitivePosition?: number;
    newsCatalyst?: number;
  } | null,
): number {
  const neutral4 = (v: number | null | undefined): number =>
    v != null && Number.isFinite(v) ? v : 4;

  const neutral15 = (v: number | null | undefined): number =>
    v != null && Number.isFinite(v) ? v : 15;

  const subtotal =
    neutral4(anchors.earningsTrajectory) +
    neutral4(anchors.balanceSheet) +
    neutral4(anchors.valuation) +
    neutral4(llmRubric?.moat) +
    neutral4(llmRubric?.sectorTailwind) +
    neutral4(llmRubric?.competitivePosition) +
    neutral4(llmRubric?.newsCatalyst);

  return subtotal + neutral15(anchors.technicalStage);
}
