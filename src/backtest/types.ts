/**
 * Shared Option A backtest types.
 */

export interface ClosedSimTrade {
  symbol: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  returnPct: number;
  maxDrawdownPct: number;
  holdDays: number;
}
