/**
 * Pure long-position simulation for Option A backtests — mirrors
 * {@link evaluateOnePaperTrade} stop/target/time logic without DB writes.
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { exitPriceWhenStopHit } from '../scripts/evaluate-trades.js';
import { applyDay1InitialStop, computeNewStop } from '../scripts/trailing-stop-engine.js';
import type { BacktestExitReason } from './types.js';

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
}

export interface LongTrailState {
  symbol: string;
  entryPrice: number;
  sourceDate: string;
  initialStopLoss: number;
  target: number;
  maxHoldDays: number;
  hardStopPct: number;
  atr14AtSourceDate: number | null;
  stopLoss: number;
  highestClose: number | null;
  initialSetupComplete: boolean;
  trailingMult: 1.5 | 2;
  /** Worst (most negative) close-based return vs entry during the hold. */
  maxDrawdownPct: number;
}

function pnlPctLong(entry: number, exit: number): number {
  return ((exit - entry) / entry) * 100;
}

function hardStopFloorFromPct(entryPrice: number, hardStopPct: number): number {
  return entryPrice * (1 + hardStopPct / 100);
}

/** Round-trip bps charged once on exit (plan: single multiplier on exit price). */
function applyExitCosts(grossExit: number, costBpsRoundTrip: number): number {
  const frac = 1 - costBpsRoundTrip / 10_000;
  return grossExit * frac;
}

function normalizeTrailingMultState(m: number): 1.5 | 2 {
  return m === 1.5 ? 1.5 : 2;
}

export function initLongTrailState(opts: {
  symbol: string;
  entryPrice: number;
  sourceDate: string;
  initialStopLoss: number;
  target: number;
  maxHoldDays: number;
  hardStopPct: number;
  atr14AtSourceDate: number | null;
}): LongTrailState {
  return {
    symbol: opts.symbol,
    entryPrice: opts.entryPrice,
    sourceDate: opts.sourceDate,
    initialStopLoss: opts.initialStopLoss,
    target: opts.target,
    maxHoldDays: opts.maxHoldDays,
    hardStopPct: opts.hardStopPct,
    atr14AtSourceDate: opts.atr14AtSourceDate,
    stopLoss: opts.initialStopLoss,
    highestClose: null,
    initialSetupComplete: opts.atr14AtSourceDate != null,
    trailingMult: 2,
    maxDrawdownPct: 0,
  };
}

/**
 * One session step (same ordering as `evaluateOnePaperTrade`).
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
  const hardFloor = hardStopFloorFromPct(state.entryPrice, state.hardStopPct);
  let stopLoss = state.stopLoss;
  let highestClose = state.highestClose;
  let initialSetupComplete = state.initialSetupComplete;
  let trailingMult = state.trailingMult;
  let maxDrawdownPct = state.maxDrawdownPct;

  const maxCloseSinceEntry = highestClose === null ? bar.close : Math.max(highestClose, bar.close);
  highestClose = maxCloseSinceEntry;

  let skipTrailThisBar = false;
  if (!initialSetupComplete) {
    stopLoss = applyDay1InitialStop(
      state.entryPrice,
      state.initialStopLoss,
      state.atr14AtSourceDate,
    );
    stopLoss = Math.max(stopLoss, hardFloor);
    initialSetupComplete = true;
    skipTrailThisBar = true;
  }

  if (initialSetupComplete && !skipTrailThisBar) {
    if (atr14Today !== undefined && Number.isFinite(atr14Today) && atr14Today > 0) {
      const res = computeNewStop({
        entryPrice: state.entryPrice,
        highestCloseSinceEntry: maxCloseSinceEntry,
        currentStopLoss: stopLoss,
        atr14Today,
        currentMultiplier: normalizeTrailingMultState(trailingMult),
      });
      stopLoss = Math.max(res.newStop, hardFloor);
      trailingMult = res.multiplier;
    }
  }

  stopLoss = Math.max(stopLoss, hardFloor);

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
      trailingMult,
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
  initialStopLoss: number;
  target: number;
  maxHoldDays: number;
  hardStopPct: number;
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
    initialStopLoss,
    target,
    maxHoldDays,
    hardStopPct,
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
    initialStopLoss,
    target,
    maxHoldDays,
    hardStopPct,
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
  };
}
