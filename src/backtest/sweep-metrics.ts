/**
 * Phase 1 initial-ATR multiplier sweep aggregates (net returns, bear sub-window).
 */

import type { ClosedSimTrade } from './types.js';

const BEAR_SUB_FROM = '2024-10-01';
const BEAR_SUB_TO = '2026-03-31';

export const PHASE1_INITIAL_MULTIPLIERS = [1.5, 2.0, 2.5, 3.0] as const;

export interface Phase1SweepRow {
  initialMultiplier: number;
  totalTrades: number;
  hitRate: number;
  netReturn: number;
  profitFactor: number;
  stopOutRate: number;
  avgLossOnStopOuts: number;
  avgHoldDaysWin: number;
  avgHoldDaysLoss: number;
  floorOverrideRate: number;
  floorBindingRate: number;
  bearSubWindowPf: number;
}

function netProfitFactor(trades: ClosedSimTrade[]): number {
  const wins = trades.filter((t) => t.returnPct > 0);
  const losses = trades.filter((t) => t.returnPct < 0);
  const sumWin = wins.reduce((s, t) => s + t.returnPct, 0);
  const sumLossAbs = losses.reduce((s, t) => s + Math.abs(t.returnPct), 0);
  if (sumLossAbs < 1e-9) return sumWin > 0 ? 999 : 0;
  return sumWin / sumLossAbs;
}

function isBearSubWindow(trade: ClosedSimTrade): boolean {
  return trade.entryDate >= BEAR_SUB_FROM && trade.exitDate <= BEAR_SUB_TO;
}

export function computePhase1SweepRow(
  initialMultiplier: number,
  trades: ClosedSimTrade[],
): Phase1SweepRow {
  const total = trades.length;
  if (total === 0) {
    return {
      initialMultiplier,
      totalTrades: 0,
      hitRate: 0,
      netReturn: 0,
      profitFactor: 0,
      stopOutRate: 0,
      avgLossOnStopOuts: 0,
      avgHoldDaysWin: 0,
      avgHoldDaysLoss: 0,
      floorOverrideRate: 0,
      floorBindingRate: 0,
      bearSubWindowPf: 0,
    };
  }

  const wins = trades.filter((t) => t.returnPct > 0);
  const losses = trades.filter((t) => t.returnPct < 0);
  const stopOuts = trades.filter(
    (t) => t.exitReason === 'TRAILING_STOP' || t.exitReason === 'INITIAL_STOP',
  );
  const stopLosses = stopOuts.filter((t) => t.returnPct < 0);

  return {
    initialMultiplier,
    totalTrades: total,
    hitRate: (wins.length / total) * 100,
    netReturn: trades.reduce((s, t) => s + t.returnPct, 0) / total,
    profitFactor: netProfitFactor(trades),
    stopOutRate: (stopOuts.length / total) * 100,
    avgLossOnStopOuts: stopLosses.length
      ? stopLosses.reduce((s, t) => s + t.returnPct, 0) / stopLosses.length
      : 0,
    avgHoldDaysWin: wins.length ? wins.reduce((s, t) => s + t.holdDays, 0) / wins.length : 0,
    avgHoldDaysLoss: losses.length ? losses.reduce((s, t) => s + t.holdDays, 0) / losses.length : 0,
    floorOverrideRate: (trades.filter((t) => t.hardFloorOverridden === true).length / total) * 100,
    floorBindingRate: (trades.filter((t) => t.floorBinding === true).length / total) * 100,
    bearSubWindowPf: netProfitFactor(trades.filter(isBearSubWindow)),
  };
}

export function formatPhase1SweepTable(rows: Phase1SweepRow[]): Record<string, string | number>[] {
  return rows.map((r) => ({
    initialMultiplier: r.initialMultiplier,
    totalTrades: r.totalTrades,
    hitRate: `${r.hitRate.toFixed(1)}%`,
    netReturn: `${r.netReturn.toFixed(2)}%`,
    profitFactor: Number(r.profitFactor.toFixed(2)),
    stopOutRate: `${r.stopOutRate.toFixed(1)}%`,
    avgLossOnStopOuts: `${r.avgLossOnStopOuts.toFixed(2)}%`,
    avgHoldDaysWin: Number(r.avgHoldDaysWin.toFixed(1)),
    avgHoldDaysLoss: Number(r.avgHoldDaysLoss.toFixed(1)),
    floorOverrideRate: `${r.floorOverrideRate.toFixed(1)}%`,
    floorBindingRate: `${r.floorBindingRate.toFixed(1)}%`,
    bearSubWindowPf: Number(r.bearSubWindowPf.toFixed(2)),
  }));
}

/** Phase 2: initial ATR locked at 2.5×; sweep tightened mult × lock-in threshold. */
export const PHASE2_FIXED_INITIAL_MULTIPLIER = 2.5;
export const PHASE2_TIGHTENED_MULTIPLIERS = [1.25, 1.5, 1.75] as const;
export const PHASE2_LOCK_IN_THRESHOLDS_PCT = [12.0, 15.0, 18.0] as const;

export interface Phase2SweepRow {
  initialMultiplier: number;
  tightenedMultiplier: number;
  lockInThresholdPct: number;
  totalTrades: number;
  hitRate: number;
  netReturn: number;
  profitFactor: number;
  stopOutRate: number;
  bearSubWindowPf: number;
  avgReturnOnTailWinners: number;
  tailWinnerCount: number;
}

export function computePhase2SweepRow(
  tightenedMultiplier: number,
  lockInThresholdPct: number,
  trades: ClosedSimTrade[],
): Phase2SweepRow {
  const total = trades.length;
  const empty: Phase2SweepRow = {
    initialMultiplier: PHASE2_FIXED_INITIAL_MULTIPLIER,
    tightenedMultiplier,
    lockInThresholdPct,
    totalTrades: 0,
    hitRate: 0,
    netReturn: 0,
    profitFactor: 0,
    stopOutRate: 0,
    bearSubWindowPf: 0,
    avgReturnOnTailWinners: 0,
    tailWinnerCount: 0,
  };
  if (total === 0) return empty;

  const wins = trades.filter((t) => t.returnPct > 0);
  const stopOuts = trades.filter(
    (t) => t.exitReason === 'TRAILING_STOP' || t.exitReason === 'INITIAL_STOP',
  );
  const tailWinners = trades.filter((t) => t.wasTailWinner === true);

  return {
    initialMultiplier: PHASE2_FIXED_INITIAL_MULTIPLIER,
    tightenedMultiplier,
    lockInThresholdPct,
    totalTrades: total,
    hitRate: (wins.length / total) * 100,
    netReturn: trades.reduce((s, t) => s + t.returnPct, 0) / total,
    profitFactor: netProfitFactor(trades),
    stopOutRate: (stopOuts.length / total) * 100,
    bearSubWindowPf: netProfitFactor(trades.filter(isBearSubWindow)),
    tailWinnerCount: tailWinners.length,
    avgReturnOnTailWinners: tailWinners.length
      ? tailWinners.reduce((s, t) => s + t.returnPct, 0) / tailWinners.length
      : 0,
  };
}

export function formatPhase2SweepTable(rows: Phase2SweepRow[]): Record<string, string | number>[] {
  return rows.map((r) => ({
    initialMult: r.initialMultiplier,
    tightenedMult: r.tightenedMultiplier,
    lockInPct: `${r.lockInThresholdPct}%`,
    totalTrades: r.totalTrades,
    hitRate: `${r.hitRate.toFixed(1)}%`,
    netReturn: `${r.netReturn.toFixed(2)}%`,
    profitFactor: Number(r.profitFactor.toFixed(2)),
    stopOutRate: `${r.stopOutRate.toFixed(1)}%`,
    bearSubWindowPf: Number(r.bearSubWindowPf.toFixed(2)),
    tailWinners: r.tailWinnerCount,
    avgReturnOnTailWinners:
      r.tailWinnerCount > 0 ? `${r.avgReturnOnTailWinners.toFixed(2)}%` : 'n/a',
  }));
}
