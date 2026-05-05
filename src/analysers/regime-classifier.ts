/**
 * Deterministic regime classification + persistence (spec §3, §10).
 * CRISIS override uses strict comparisons: VIX **>** 28, gap **<** -3% (§10.2 boundaries).
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { getDb } from '../db/connection.js';
import { getTodayRegime, insertRegimeRow } from '../db/regime-queries.js';
import { computeRegimeSignals } from '../enrichers/regime-signals.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { lastOpenOnOrBefore, previousOpenTradingDay } from '../market/trading-days.js';
import type { Regime, RegimeClassification, RegimeSignals } from '../types/regime.js';

/** `true` when CRISIS override applies (VIX spike or large gap down). Not triggered at VIX===28 or gap===-3 (strict `>` / `<`). */
export function computeCrisisOverride(signals: RegimeSignals): boolean {
  const vix = signals.vixCurrent;
  if (vix != null && vix > 28) return true;
  const gap = signals.niftyGapPct;
  if (gap != null && gap < -3) return true;
  return false;
}

/**
 * Map aggregate score to regime (TABLE 10, non-override rows only — never returns CRISIS).
 *
 * Bands: ≥8 BULL; ≥2 BULL; [-2,2) CHOPPY; [-7,-2) BEAR; &lt;-7 BEAR.
 */
export function mapScoreTotalToRegime(scoreTotal: number): Exclude<Regime, 'CRISIS'> {
  if (scoreTotal >= 8) return 'BULL_TRENDING';
  if (scoreTotal >= 2) return 'BULL_TRENDING';
  if (scoreTotal >= -2 && scoreTotal < 2) return 'CHOPPY';
  if (scoreTotal >= -7 && scoreTotal < -2) return 'BEAR_TRENDING';
  return 'BEAR_TRENDING';
}

/** Raw regime including crisis override path. */
export function computeRawRegime(signals: RegimeSignals): Regime {
  if (computeCrisisOverride(signals)) return 'CRISIS';
  return mapScoreTotalToRegime(signals.scoreTotal);
}

/**
 * Count consecutive **open** sessions ending at `endSessionDate` where crisis override was false each day.
 * Persistence only needs to distinguish &lt; 5 vs ≥ 5 (spec §3.3), so we **return as soon as `n >= 5`**.
 * If VIX/gap are always null, `computeCrisisOverride` is never true — without an early return the walk
 * would continue until calendar arithmetic yields invalid dates (e.g. `"999-12-31"`).
 */
export function countTrailingNonCrisisOverrideDays(
  db: DatabaseType,
  endSessionDate: string,
): number {
  let n = 0;
  let d: string | null = lastOpenOnOrBefore(endSessionDate);
  let guard = 0;
  const MAX_ITER = 260;

  while (d != null && guard < MAX_ITER) {
    guard++;
    const sig = computeRegimeSignals(db, d);
    if (computeCrisisOverride(sig)) break;
    n++;
    if (n >= 5) return n;
    d = previousOpenTradingDay(d);
  }
  return n;
}

/**
 * Persisted regime after override + persistence rules (§3.3).
 *
 * - Crisis override → CRISIS immediately.
 * - Else if yesterday was CRISIS and fewer than 5 consecutive non-crisis sessions → stay CRISIS.
 * - Else if yesterday was CRISIS with streak ≥5, release CRISIS lock (`effectivePrev=null`) then apply 3-day raw-score agreement.
 * - Else require three consecutive sessions with the same **score-based** regime to switch; otherwise hold `persistedYesterday`.
 */
export function applyPersistence(params: {
  crisisOverrideToday: boolean;
  rawScoreToday: Exclude<Regime, 'CRISIS'>;
  rawScorePrev1: Exclude<Regime, 'CRISIS'> | null;
  rawScorePrev2: Exclude<Regime, 'CRISIS'> | null;
  persistedYesterday: Regime | null;
  nonCrisisOverrideStreak: number;
}): Regime {
  const {
    crisisOverrideToday,
    rawScoreToday,
    rawScorePrev1,
    rawScorePrev2,
    persistedYesterday,
    nonCrisisOverrideStreak,
  } = params;

  if (crisisOverrideToday) return 'CRISIS';

  if (persistedYesterday === 'CRISIS' && nonCrisisOverrideStreak < 5) {
    return 'CRISIS';
  }

  let effectivePrev: Regime | null = persistedYesterday;
  if (persistedYesterday === 'CRISIS' && nonCrisisOverrideStreak >= 5) {
    effectivePrev = null;
  }

  const threeMatch =
    rawScorePrev1 != null &&
    rawScorePrev2 != null &&
    rawScoreToday === rawScorePrev1 &&
    rawScoreToday === rawScorePrev2;

  if (threeMatch) return rawScoreToday;

  return effectivePrev ?? rawScoreToday;
}

export interface RunRegimeClassifierOptions {
  date?: string;
}

/**
 * Compute signals → deterministic regime → upsert `regime_daily` (`narrative` null).
 */
export function runRegimeClassifier(
  opts: RunRegimeClassifierOptions = {},
  db: DatabaseType = getDb(),
): RegimeClassification {
  const requested = opts.date ?? isoDateIst();
  const sessionDate = lastOpenOnOrBefore(requested) ?? requested;

  const signals = computeRegimeSignals(db, sessionDate);
  const crisisToday = computeCrisisOverride(signals);
  const rawScoreToday = mapScoreTotalToRegime(signals.scoreTotal);

  const prevDate = previousOpenTradingDay(sessionDate);
  const prevRow = prevDate ? getTodayRegime(prevDate, db) : null;
  const persistedYesterday = prevRow?.regime ?? null;

  let rawScorePrev1: Exclude<Regime, 'CRISIS'> | null = null;
  let rawScorePrev2: Exclude<Regime, 'CRISIS'> | null = null;
  if (prevDate) {
    const s1 = computeRegimeSignals(db, prevDate);
    rawScorePrev1 = mapScoreTotalToRegime(s1.scoreTotal);
    const d2 = previousOpenTradingDay(prevDate);
    if (d2) {
      const s2 = computeRegimeSignals(db, d2);
      rawScorePrev2 = mapScoreTotalToRegime(s2.scoreTotal);
    }
  }

  const streak = countTrailingNonCrisisOverrideDays(db, sessionDate);

  const regime = applyPersistence({
    crisisOverrideToday: crisisToday,
    rawScoreToday,
    rawScorePrev1,
    rawScorePrev2,
    persistedYesterday,
    nonCrisisOverrideStreak: streak,
  });

  const regimeAge =
    persistedYesterday != null && regime === persistedYesterday ? (prevRow?.regimeAge ?? 0) + 1 : 1;

  insertRegimeRow(
    {
      date: sessionDate,
      regime,
      scoreTotal: signals.scoreTotal,
      scoreTrend: signals.scoreTrend,
      scoreVix: signals.scoreVix,
      scoreFii: signals.scoreFii,
      scoreBreadth: signals.scoreBreadth,
      vixValue: signals.vixCurrent ?? 0,
      niftyVsSma200: signals.niftyVsSma200Pct ?? 0,
      fii20dNet: signals.fii20dRollingCr ?? 0,
      adRatio: signals.adRatio,
      pctAboveSma200: signals.pctAboveSma200,
      crisisOverride: crisisToday,
      narrative: null,
      prevRegime: persistedYesterday,
      regimeAge,
    },
    db,
  );

  return {
    regime,
    rawRegime: computeRawRegime(signals),
    crisisOverride: crisisToday,
    regimeAge,
    prevRegime: persistedYesterday,
    scoreBreakdown: {
      trend: signals.scoreTrend,
      vix: signals.scoreVix,
      fii: signals.scoreFii,
      breadth: signals.scoreBreadth,
    },
  };
}
