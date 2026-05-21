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
}
