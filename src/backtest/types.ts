/**
 * Shared Option A backtest types.
 */

/** Persisted to `backtest_trades.exit_reason` (Option A + position sim). */
export type BacktestExitReason =
  | 'TRAILING_STOP'
  | 'INITIAL_STOP'
  | 'TARGET_HIT'
  | 'TIME_EXIT'
  | 'RANK_DECAY'
  | 'REGIME_EXIT'
  | 'WINDOW_END';

export interface ClosedSimTrade {
  symbol: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  returnPct: number;
  maxDrawdownPct: number;
  holdDays: number;
  exitReason: BacktestExitReason;
  /** True when structural -8% floor bound the stop at any point during the hold. */
  hardFloorOverridden?: boolean;
  /** True when hardFloor > raw ATR stop at any bar during the hold. */
  floorBinding?: boolean;
  /** True once peak unrealized gain crossed the lock-in threshold during the hold. */
  wasTailWinner?: boolean;
}
