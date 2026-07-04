/**
 * Deterministic admission gate for AI_PICK paper-trade insertion.
 * Thesis cards may still appear in the briefing; this only gates `paper_trades`.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { config } from '../config/env.js';
import { getRegimeForCalendarDate } from '../db/regime-queries.js';
import { child } from '../logger.js';
import type { ThesisCard } from './template.js';

const log = child({ component: 'ai-pick-gate' });

export type AiPickBlockReason =
  | 'confidence_low'
  | 'false_momentum_flag'
  | 'golden_cross_stale_rank'
  | 'golden_cross_rejected'
  | 'rubric_low'
  | 'no_confirmation_path';

export type AiPickConfirmPath =
  | 'path_a_non_generic_screen'
  | 'path_b_alert_breakout'
  | 'golden_cross_elite'
  | 'golden_cross_mid';

export interface AiPickGateResult {
  eligible: boolean;
  reasons: AiPickBlockReason[];
  path?: AiPickConfirmPath;
  facts: Record<string, unknown>;
}

interface SignalPoint {
  value: number;
  date: string;
}

function getLatestSignal(
  symbol: string,
  name: string,
  asOfDate: string,
  db: DatabaseType,
): SignalPoint | null {
  const row = db
    .prepare(
      `
      SELECT value, date FROM signals
      WHERE symbol = ? AND name = ? AND date <= ?
      ORDER BY date DESC LIMIT 1
    `,
    )
    .get(symbol.toUpperCase(), name, asOfDate) as { value: number; date: string } | undefined;
  if (!row) return null;
  return { value: row.value, date: row.date };
}

/** Point-in-time NIFTY_50 quotes as session calendar (same pattern as evaluate-trades). */
export function getTwoSessionsBackDate(db: DatabaseType, sourceDate: string): string | null {
  return (
    (
      db
        .prepare(
          `
      SELECT date FROM quotes
      WHERE symbol = 'NIFTY_50' AND date < ?
      ORDER BY date DESC LIMIT 1 OFFSET 1
    `,
        )
        .get(sourceDate) as { date: string } | undefined
    )?.date ?? null
  );
}

function isSignalFresh(sig: SignalPoint | null, twoBack: string | null): boolean {
  if (sig == null) return false;
  if (twoBack == null) return false;
  return sig.date >= twoBack;
}

function getClose(symbol: string, sourceDate: string, db: DatabaseType): number | null {
  const row = db
    .prepare(`SELECT close FROM quotes WHERE symbol = ? AND exchange = 'NSE' AND date = ?`)
    .get(symbol.toUpperCase(), sourceDate) as { close: number } | undefined;
  return row?.close ?? null;
}

function getSameDayScreens(symbol: string, sourceDate: string, db: DatabaseType): string[] {
  const rows = db
    .prepare(`SELECT screen_name AS screenName FROM screens WHERE symbol = ? AND date = ?`)
    .all(symbol.toUpperCase(), sourceDate) as { screenName: string }[];
  return rows.map((r) => r.screenName);
}

function hasAlert(symbol: string, sourceDate: string, kind: string, db: DatabaseType): boolean {
  const row = db
    .prepare(`SELECT 1 FROM alerts WHERE symbol = ? AND date = ? AND kind = ? LIMIT 1`)
    .get(symbol.toUpperCase(), sourceDate, kind);
  return row != null;
}

function evaluatePathA(screens: string[]): boolean {
  return screens.some((s) => s !== 'golden_cross');
}

function evaluatePathB(
  symbol: string,
  sourceDate: string,
  db: DatabaseType,
  close: number | null,
  sma50: SignalPoint | null,
  sma200: SignalPoint | null,
  volRatio: SignalPoint | null,
): boolean {
  if (!hasAlert(symbol, sourceDate, 'near_52w_high', db)) return false;
  const volumeOk =
    hasAlert(symbol, sourceDate, 'volume_spike', db) || (volRatio != null && volRatio.value >= 1.5);
  if (!volumeOk) return false;
  if (close == null || sma50 == null || sma200 == null) return false;
  return close > sma50.value && close > sma200.value;
}

function signalFacts(sig: SignalPoint | null, fresh?: boolean): Record<string, unknown> {
  return { value: sig?.value ?? null, date: sig?.date ?? null, fresh };
}

function evaluatePathC(
  rank: SignalPoint | null,
  falseFlag: SignalPoint | null,
  rs: SignalPoint | null,
  rankFresh: boolean,
  falseFlagFresh: boolean,
  symbol: string,
  sourceDate: string,
  db: DatabaseType,
  volRatio: SignalPoint | null,
): { ok: boolean; path?: AiPickConfirmPath; reason?: AiPickBlockReason } {
  if (!rankFresh || rank == null) {
    return { ok: false, reason: 'golden_cross_stale_rank' };
  }
  if (!falseFlagFresh || falseFlag == null) {
    return { ok: false, reason: 'golden_cross_stale_rank' };
  }
  if (falseFlag.value === 1) {
    return { ok: false, reason: 'false_momentum_flag' };
  }
  if (rs == null || rs.value <= 0) {
    return { ok: false, reason: 'golden_cross_rejected' };
  }
  const rankVal = rank.value;
  if (rankVal <= 5) {
    return { ok: true, path: 'golden_cross_elite' };
  }
  if (rankVal <= 10) {
    const midConfirm =
      hasAlert(symbol, sourceDate, 'near_52w_high', db) ||
      (volRatio != null && volRatio.value >= 1.2);
    if (!midConfirm) {
      return { ok: false, reason: 'golden_cross_rejected' };
    }
    return { ok: true, path: 'golden_cross_mid' };
  }
  return { ok: false, reason: 'golden_cross_rejected' };
}

/**
 * Load rubric_json from the theses table for the given symbol and date.
 * Returns null when no rubric data exists (pre-migration rows, or rows where LLM didn't return rubric).
 */
function loadRubricJson(
  symbol: string,
  sourceDate: string,
  db: DatabaseType,
): { total: number } | null {
  try {
    const row = db
      .prepare(`SELECT rubric_json FROM theses WHERE symbol = ? AND date = ?`)
      .get(symbol.toUpperCase(), sourceDate) as { rubric_json: string | null } | undefined;
    if (!row?.rubric_json) return null;
    const parsed = JSON.parse(row.rubric_json) as { total?: number };
    if (typeof parsed.total !== 'number' || !Number.isFinite(parsed.total)) return null;
    return { total: parsed.total };
  } catch {
    return null;
  }
}

export function evaluateAiPickEligibility(
  symbol: string,
  sourceDate: string,
  thesis: Pick<ThesisCard, 'confidence'>,
  db: DatabaseType,
): AiPickGateResult {
  const sym = symbol.toUpperCase();
  const facts: Record<string, unknown> = { symbol: sym, sourceDate, confidence: thesis.confidence };

  // ---- Rubric shadow logging (Task A) ----
  // When AI_PICK_RUBRIC_GATE=1, the rubric gate replaces confidence-based gating.
  // When '0' (default), we shadow-log for calibration without changing behaviour.
  if (config.AI_PICK_RUBRIC_GATE === '1') {
    const rubric = loadRubricJson(sym, sourceDate, db);
    if (rubric) {
      const rubricEligible = rubric.total >= config.AI_PICK_RUBRIC_MIN;
      facts.rubricTotal = rubric.total;
      facts.rubricEligible = rubricEligible;
      facts.rubricGateMin = config.AI_PICK_RUBRIC_MIN;
      if (!rubricEligible) {
        return {
          eligible: false,
          reasons: ['rubric_low'],
          facts,
        };
      }
    }
    // When rubric gate is enabled, rubric replaces the confidence<6 check entirely.
    // The rubric check above handles the gate; fall through to path-based gates below,
    // and the confidence<6 check is skipped via the `&& AI_PICK_RUBRIC_GATE !== '1'` guard.
  } else {
    // Shadow mode: log rubric disagreement stats for calibration
    const rubric = loadRubricJson(sym, sourceDate, db);
    if (rubric) {
      const rubricEligible = rubric.total >= config.AI_PICK_RUBRIC_MIN;
      facts.rubricTotal = rubric.total;
      facts.rubricEligible = rubricEligible;
      facts.rubricDisagreesWithConfidence = rubricEligible !== thesis.confidence >= 6;
      if (rubricEligible !== thesis.confidence >= 6) {
        log.info(
          {
            symbol: sym,
            sourceDate,
            confidence: thesis.confidence,
            rubricTotal: rubric.total,
            rubricEligible,
            rubricMin: config.AI_PICK_RUBRIC_MIN,
          },
          'rubric-confidence disagreement (shadow)',
        );
      }
    }
  }

  if (thesis.confidence < 6 && config.AI_PICK_RUBRIC_GATE !== '1') {
    return {
      eligible: false,
      reasons: ['confidence_low'],
      facts,
    };
  }

  const regimeRow = getRegimeForCalendarDate(sourceDate, db);
  const regime = regimeRow?.regime ?? null;
  facts.regime = regime;

  const twoBack = getTwoSessionsBackDate(db, sourceDate);
  facts.twoSessionsBackDate = twoBack;

  const rankSig = getLatestSignal(sym, 'mom_rank', sourceDate, db);
  const falseFlagSig = getLatestSignal(sym, 'mom_false_flag', sourceDate, db);
  const rsSig = getLatestSignal(sym, 'mom_relative_strength_ba', sourceDate, db);
  const sma50Sig = getLatestSignal(sym, 'sma_50', sourceDate, db);
  const sma200Sig = getLatestSignal(sym, 'sma_200', sourceDate, db);
  const volRatioSig = getLatestSignal(sym, 'volume_ratio_20d', sourceDate, db);
  const close = getClose(sym, sourceDate, db);
  const near52wHighAlert = hasAlert(sym, sourceDate, 'near_52w_high', db);
  const volumeSpikeAlert = hasAlert(sym, sourceDate, 'volume_spike', db);
  const rankFresh = isSignalFresh(rankSig, twoBack);
  const falseFlagFresh = isSignalFresh(falseFlagSig, twoBack);

  facts.signals = {
    momRank: signalFacts(rankSig, rankFresh),
    momFalseFlag: signalFacts(falseFlagSig, falseFlagFresh),
    relativeStrength: signalFacts(rsSig),
    sma50: signalFacts(sma50Sig),
    sma200: signalFacts(sma200Sig),
    volumeRatio20d: signalFacts(volRatioSig),
  };
  facts.close = close;
  facts.alerts = { near52wHigh: near52wHighAlert, volumeSpike: volumeSpikeAlert };
  facts.technicals = {
    closeAboveSma50: close != null && sma50Sig != null ? close > sma50Sig.value : null,
    closeAboveSma200: close != null && sma200Sig != null ? close > sma200Sig.value : null,
    volumeRatioOk15: volRatioSig != null ? volRatioSig.value >= 1.5 : null,
    volumeRatioOk12: volRatioSig != null ? volRatioSig.value >= 1.2 : null,
  };
  facts.momRank = rankSig?.value ?? null;
  facts.momRankDate = rankSig?.date ?? null;
  facts.momFalseFlag = falseFlagSig?.value ?? null;
  facts.momFalseFlagDate = falseFlagSig?.date ?? null;
  facts.rankFresh = rankFresh;
  facts.falseFlagFresh = falseFlagFresh;

  if (falseFlagFresh && falseFlagSig != null && falseFlagSig.value === 1) {
    return { eligible: false, reasons: ['false_momentum_flag'], facts };
  }

  const screens = getSameDayScreens(sym, sourceDate, db);
  facts.screens = screens;
  const hasGoldenCross = screens.includes('golden_cross');
  const hasNonGeneric = evaluatePathA(screens);
  const goldenCrossOnly = hasGoldenCross && !hasNonGeneric;

  if (hasNonGeneric) {
    return {
      eligible: true,
      reasons: [],
      path: 'path_a_non_generic_screen',
      facts,
    };
  }

  if (evaluatePathB(sym, sourceDate, db, close, sma50Sig, sma200Sig, volRatioSig)) {
    return {
      eligible: true,
      reasons: [],
      path: 'path_b_alert_breakout',
      facts,
    };
  }

  if (regime === 'CHOPPY' && hasGoldenCross) {
    const pathC = evaluatePathC(
      rankSig,
      falseFlagSig,
      rsSig,
      rankFresh,
      falseFlagFresh,
      sym,
      sourceDate,
      db,
      volRatioSig,
    );
    if (pathC.ok && pathC.path) {
      return { eligible: true, reasons: [], path: pathC.path, facts };
    }
    if (pathC.reason) {
      return { eligible: false, reasons: [pathC.reason], facts };
    }
  }

  if (goldenCrossOnly) {
    if (!rankFresh || rankSig == null) {
      return { eligible: false, reasons: ['golden_cross_stale_rank'], facts };
    }
    return { eligible: false, reasons: ['no_confirmation_path'], facts };
  }

  return { eligible: false, reasons: ['no_confirmation_path'], facts };
}
