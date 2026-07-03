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

export interface RubricAnchors {
  /** Earnings trajectory from quarterly_fundamentals PAT YoY. 0–10, null when < 2 quarters available. */
  earningsTrajectory: number | null;
  /** Balance sheet from D/E and ROE. 0–10, null when D/E or ROE missing. */
  balanceSheet: number | null;
  /** Weinstein stage score from signals (already 0/8/15/25/30 → mapped to 0–30). Null if absent or code = 0. */
  technicalStage: number | null;
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

  return { earningsTrajectory, balanceSheet, technicalStage };
}

/**
 * Compute the composite rubric total on a 0–90 scale.
 *
 * Formula:
 *   earningsTrajectory (0–10, null→4)
 *   + balanceSheet (0–10, null→4)
 *   + moat (0–10, null→4)
 *   + sectorTailwind (0–10, null→4)
 *   + competitivePosition (0–10, null→4)
 *   + newsCatalyst (0–10, null→4)
 *   = 0–60 subtotal
 *   + technicalStage (0–30, null→15)
 *   = 0–90 total
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
    neutral4(llmRubric?.moat) +
    neutral4(llmRubric?.sectorTailwind) +
    neutral4(llmRubric?.competitivePosition) +
    neutral4(llmRubric?.newsCatalyst);

  return subtotal + neutral15(anchors.technicalStage);
}
