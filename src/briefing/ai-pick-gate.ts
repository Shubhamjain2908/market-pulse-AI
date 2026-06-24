/**
 * Deterministic admission gate for AI_PICK paper-trade insertion.
 * Thesis cards may still appear in the briefing; this only gates `paper_trades`.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { getRegimeForCalendarDate } from '../db/regime-queries.js';
import type { ThesisCard } from './template.js';

export type AiPickBlockReason =
  | 'confidence_low'
  | 'false_momentum_flag'
  | 'golden_cross_stale_rank'
  | 'golden_cross_rejected'
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

/** ponytail: NIFTY_50 quotes as session calendar (same pattern as evaluate-trades). */
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

export function evaluateAiPickEligibility(
  symbol: string,
  sourceDate: string,
  thesis: Pick<ThesisCard, 'confidence'>,
  db: DatabaseType,
): AiPickGateResult {
  const sym = symbol.toUpperCase();
  const facts: Record<string, unknown> = { symbol: sym, sourceDate };

  if (thesis.confidence < 6) {
    return {
      eligible: false,
      reasons: ['confidence_low'],
      facts: { ...facts, confidence: thesis.confidence },
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

  facts.momRank = rankSig?.value ?? null;
  facts.momRankDate = rankSig?.date ?? null;
  facts.momFalseFlag = falseFlagSig?.value ?? null;
  facts.momFalseFlagDate = falseFlagSig?.date ?? null;

  if (falseFlagSig != null && falseFlagSig.value === 1) {
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

  const rankFresh = isSignalFresh(rankSig, twoBack);
  const falseFlagFresh = isSignalFresh(falseFlagSig, twoBack);
  facts.rankFresh = rankFresh;
  facts.falseFlagFresh = falseFlagFresh;

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
