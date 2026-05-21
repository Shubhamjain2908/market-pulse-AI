/**
 * Pure long-position simulation for Option A backtests — mirrors
 * {@link evaluateOnePaperTrade} stop/target/time logic without DB writes.
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { exitPriceWhenStopHit } from '../scripts/evaluate-trades.js';
import type { BacktestExitReason } from './types.js';

/** Phase 2 sweep target — do not inline in step logic. */
export const TIGHTENED_MULTIPLIER = 1.5;

const HARD_FLOOR_PCT = 0.92;

export interface SimOhlcBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface LongPositionSimResult {
  exitDate: string;
  exitGrossPrice: number;
  exitNetPrice: number;
  /** Net return % vs entry (after round-trip cost applied at exit). */
  returnPct: number;
  maxDrawdownPct: number;
  holdDays: number;
  /** Same labelling as paper `evaluate-trades` for stops (`skipTrailThisBar` → INITIAL_STOP). */
  exitReason: BacktestExitReason;
  hardFloorOverridden: boolean;
  /** True when structural floor was above raw ATR stop at any point during the hold. */
  floorBinding: boolean;
}

export interface LongTrailState {
  symbol: string;
  entryPrice: number;
  sourceDate: string;
  initialMultiplier: number;
  /** Pre-entry stop (LLM/config); used for day-1 latch when ATR at source is missing. */
  initialStopLoss: number;
  target: number;
  maxHoldDays: number;
  hardFloor: number;
  hardFloorOverridden: boolean;
  floorBinding: boolean;
  atr14AtSourceDate: number | null;
  stopLoss: number;
  highestClose: number | null;
  initialSetupComplete: boolean;
  /** Worst (most negative) close-based return vs entry during the hold. */
  maxDrawdownPct: number;
}

function pnlPctLong(entry: number, exit: number): number {
  return ((exit - entry) / entry) * 100;
}

/** Round-trip bps charged once on exit (plan: single multiplier on exit price). */
function applyExitCosts(grossExit: number, costBpsRoundTrip: number): number {
  const frac = 1 - costBpsRoundTrip / 10_000;
  return grossExit * frac;
}

function hardFloorFromEntry(entryPrice: number): number {
  return entryPrice * HARD_FLOOR_PCT;
}

function candidateInitialStop(
  entryPrice: number,
  initialMultiplier: number,
  atr14AtEntry: number,
): number {
  return entryPrice - initialMultiplier * atr14AtEntry;
}

function activeMultiplier(
  entryPrice: number,
  highestCloseSinceEntry: number,
  initialMultiplier: number,
): number {
  const unrealisedPct = ((highestCloseSinceEntry - entryPrice) / entryPrice) * 100;
  return unrealisedPct >= 15 ? TIGHTENED_MULTIPLIER : initialMultiplier;
}

export function initLongTrailState(opts: {
  symbol: string;
  entryPrice: number;
  sourceDate: string;
  initialMultiplier: number;
  /** Fallback when ATR at entry is unavailable (e.g. pre-computed LLM stop). */
  initialStopLoss: number;
  target: number;
  maxHoldDays: number;
  atr14AtSourceDate: number | null;
}): LongTrailState {
  const hardFloor = hardFloorFromEntry(opts.entryPrice);
  let stopLoss = opts.initialStopLoss;
  let hardFloorOverridden = false;
  let floorBinding = false;

  if (
    opts.atr14AtSourceDate != null &&
    Number.isFinite(opts.atr14AtSourceDate) &&
    opts.atr14AtSourceDate > 0
  ) {
    const computed = candidateInitialStop(
      opts.entryPrice,
      opts.initialMultiplier,
      opts.atr14AtSourceDate,
    );
    if (hardFloor > computed) floorBinding = true;
    if (computed < hardFloor) {
      stopLoss = hardFloor;
      hardFloorOverridden = true;
    } else {
      stopLoss = computed;
    }
  } else if (stopLoss < hardFloor) {
    stopLoss = hardFloor;
    hardFloorOverridden = true;
  }

  return {
    symbol: opts.symbol,
    entryPrice: opts.entryPrice,
    sourceDate: opts.sourceDate,
    initialMultiplier: opts.initialMultiplier,
    initialStopLoss: opts.initialStopLoss,
    target: opts.target,
    maxHoldDays: opts.maxHoldDays,
    hardFloor,
    hardFloorOverridden,
    floorBinding,
    atr14AtSourceDate: opts.atr14AtSourceDate,
    stopLoss,
    highestClose: null,
    initialSetupComplete: opts.atr14AtSourceDate != null,
    maxDrawdownPct: 0,
  };
}

/**
 * One session step — strict EOD chronology for Phase 1 unconfounded sweep.
 * Returns `closed` when the position ends; otherwise updated `state`.
 */
export function stepLongPositionOneBar(
  state: LongTrailState,
  bar: SimOhlcBar,
  atr14Today: number | undefined,
  elapsedTradingDays: number,
  db: DatabaseType,
  costBpsRoundTrip: number,
): { status: 'open'; state: LongTrailState } | { status: 'closed'; result: LongPositionSimResult } {
  let stopLoss = state.stopLoss;
  let highestClose = state.highestClose;
  let initialSetupComplete = state.initialSetupComplete;
  let hardFloorOverridden = state.hardFloorOverridden;
  let floorBinding = state.floorBinding;
  const { hardFloor } = state;

  const highestCloseSinceEntry =
    highestClose === null ? bar.close : Math.max(highestClose, bar.close);
  highestClose = highestCloseSinceEntry;

  let skipTrailThisBar = false;
  if (!initialSetupComplete) {
    stopLoss = Math.max(state.initialStopLoss, stopLoss, hardFloor);
    if (stopLoss <= hardFloor) {
      stopLoss = hardFloor;
      hardFloorOverridden = true;
    }
    initialSetupComplete = true;
    skipTrailThisBar = true;
  }

  if (initialSetupComplete && !skipTrailThisBar) {
    if (atr14Today !== undefined && Number.isFinite(atr14Today) && atr14Today > 0) {
      const mult = activeMultiplier(
        state.entryPrice,
        highestCloseSinceEntry,
        state.initialMultiplier,
      );
      const computedATRStop = highestCloseSinceEntry - mult * atr14Today;
      if (hardFloor > computedATRStop) floorBinding = true;
      stopLoss = Math.max(computedATRStop, stopLoss);
      if (stopLoss <= hardFloor) {
        stopLoss = hardFloor;
        hardFloorOverridden = true;
      }
    }
  }

  stopLoss = Math.max(stopLoss, hardFloor);
  if (stopLoss <= hardFloor) hardFloorOverridden = true;

  const prevCloseRow = db
    .prepare(
      `SELECT close FROM quotes WHERE symbol = ? AND exchange = 'NSE' AND date < ? ORDER BY date DESC LIMIT 1`,
    )
    .get(state.symbol, bar.date) as { close: number } | undefined;
  const prevClose = prevCloseRow?.close;

  let skipStopTargetThisBar = false;
  if (prevClose != null && Number.isFinite(prevClose) && bar.open < prevClose * 0.7) {
    skipStopTargetThisBar = true;
  }

  const unrealisedClose = ((bar.close - state.entryPrice) / state.entryPrice) * 100;
  let maxDrawdownPct = state.maxDrawdownPct;
  if (unrealisedClose < maxDrawdownPct) maxDrawdownPct = unrealisedClose;

  const finish = (
    grossExit: number,
    exitReason: BacktestExitReason,
    exitDate: string,
    holdDays: number,
  ): LongPositionSimResult => {
    const exitNet = applyExitCosts(grossExit, costBpsRoundTrip);
    return {
      exitDate,
      exitGrossPrice: grossExit,
      exitNetPrice: exitNet,
      returnPct: pnlPctLong(state.entryPrice, exitNet),
      maxDrawdownPct: Math.min(0, maxDrawdownPct),
      holdDays,
      exitReason,
      hardFloorOverridden,
      floorBinding,
    };
  };

  const hitSl = bar.low <= stopLoss;
  const hitTg = bar.close >= state.target;

  if (!skipStopTargetThisBar && hitSl && hitTg) {
    const exitPx = exitPriceWhenStopHit(bar, stopLoss);
    const exitReason: BacktestExitReason = skipTrailThisBar ? 'INITIAL_STOP' : 'TRAILING_STOP';
    return {
      status: 'closed',
      result: finish(exitPx, exitReason, bar.date, elapsedTradingDays),
    };
  }

  if (!skipStopTargetThisBar && hitSl) {
    const exitPx = exitPriceWhenStopHit(bar, stopLoss);
    const exitReason: BacktestExitReason = skipTrailThisBar ? 'INITIAL_STOP' : 'TRAILING_STOP';
    return { status: 'closed', result: finish(exitPx, exitReason, bar.date, elapsedTradingDays) };
  }

  if (!skipStopTargetThisBar && hitTg) {
    return {
      status: 'closed',
      result: finish(state.target, 'TARGET_HIT', bar.date, elapsedTradingDays),
    };
  }

  if (elapsedTradingDays >= state.maxHoldDays) {
    return {
      status: 'closed',
      result: finish(bar.close, 'TIME_EXIT', bar.date, elapsedTradingDays),
    };
  }

  return {
    status: 'open',
    state: {
      ...state,
      stopLoss,
      highestClose,
      initialSetupComplete,
      hardFloorOverridden,
      floorBinding,
      maxDrawdownPct,
    },
  };
}

/**
 * Walk OHLC bars after entry until stop, target, or time exit.
 *
 * @param bars — ascending dates, `date > sourceDate`
 * @param dayIndex — `buildTradingDayIndex(db, sourceDate, lastDateInSeries)`
 */
export function simulateLongPositionUntilClose(opts: {
  symbol: string;
  entryPrice: number;
  sourceDate: string;
  initialMultiplier: number;
  initialStopLoss: number;
  target: number;
  maxHoldDays: number;
  atr14AtSourceDate: number | null;
  bars: SimOhlcBar[];
  atr14ByDate: Map<string, number | undefined>;
  dayIndex: Map<string, number>;
  costBpsRoundTrip: number;
  db: DatabaseType;
}): LongPositionSimResult | null {
  const {
    symbol,
    entryPrice,
    sourceDate,
    initialMultiplier,
    initialStopLoss,
    target,
    maxHoldDays,
    atr14AtSourceDate,
    bars,
    atr14ByDate,
    dayIndex,
    costBpsRoundTrip,
    db,
  } = opts;

  if (bars.length === 0 || entryPrice <= 0) return null;

  let state = initLongTrailState({
    symbol,
    entryPrice,
    sourceDate,
    initialMultiplier,
    initialStopLoss,
    target,
    maxHoldDays,
    atr14AtSourceDate,
  });

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!bar) continue;
    const elapsed = dayIndex.get(bar.date) ?? 0;
    const atrToday = atr14ByDate.get(bar.date);
    const out = stepLongPositionOneBar(state, bar, atrToday, elapsed, db, costBpsRoundTrip);
    if (out.status === 'closed') return out.result;
    state = out.state;
  }

  const last = bars[bars.length - 1];
  if (!last) return null;
  const elapsedLast = dayIndex.get(last.date) ?? 0;
  const exitNet = applyExitCosts(last.close, costBpsRoundTrip);
  return {
    exitDate: last.date,
    exitGrossPrice: last.close,
    exitNetPrice: exitNet,
    returnPct: pnlPctLong(entryPrice, exitNet),
    maxDrawdownPct: Math.min(0, state.maxDrawdownPct),
    holdDays: elapsedLast,
    exitReason: 'WINDOW_END',
    hardFloorOverridden: state.hardFloorOverridden,
    floorBinding: state.floorBinding,
  };
}
