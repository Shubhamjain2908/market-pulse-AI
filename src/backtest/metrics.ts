/**
 * Pure trade-aggregation math. No DB, no I/O, no logging — just numbers
 * in, summary out. This is the file that's easiest to unit-test against
 * known reference values.
 *
 * A "trade" here is a hypothetical buy-on-screen-trigger / sell-after-N-
 * sessions transaction. We compute the realised return, the worst close
 * during the hold (drawdown proxy), and aggregate across many trades.
 */

export interface Bar {
  date: string;
  close: number;
}

export interface Trade {
  symbol: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  /** % return ((exit - entry) / entry) * 100. Sign-preserving. */
  returnPct: number;
  /** Worst (most negative) close % during the hold relative to entry. <= 0. */
  maxDrawdownPct: number;
  holdDays: number;
}

export interface AggregateMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  /** Fraction of trades with returnPct > 0. */
  hitRate: number;
  avgReturnPct: number;
  medianReturnPct: number;
  maxReturnPct: number;
  minReturnPct: number;
  /** Worst single-trade drawdown across the run. <= 0. */
  maxDrawdownPct: number;
}

/**
 * Build a Trade from an entry bar and the held subsequent bars. The exit
 * is the first bar at index >= holdDays (or the last available bar if
 * fewer remain).
 */
export function buildTrade(
  symbol: string,
  entry: Bar,
  forwardBars: Bar[],
  holdDays: number,
): Trade | null {
  if (forwardBars.length === 0 || entry.close <= 0) return null;
  const exitIdx = Math.min(holdDays - 1, forwardBars.length - 1);
  const exitBar = forwardBars[exitIdx];
  if (!exitBar) return null;

  const returnPct = ((exitBar.close - entry.close) / entry.close) * 100;
  let worstClose = entry.close;
  for (let i = 0; i <= exitIdx; i++) {
    const c = forwardBars[i]?.close;
    if (c != null && c < worstClose) worstClose = c;
  }
  const maxDrawdownPct = ((worstClose - entry.close) / entry.close) * 100;

  return {
    symbol,
    entryDate: entry.date,
    entryPrice: entry.close,
    exitDate: exitBar.date,
    exitPrice: exitBar.close,
    returnPct,
    maxDrawdownPct: Math.min(0, maxDrawdownPct),
    holdDays: exitIdx + 1,
  };
}

export function aggregate(trades: Trade[]): AggregateMetrics {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      hitRate: 0,
      avgReturnPct: 0,
      medianReturnPct: 0,
      maxReturnPct: 0,
      minReturnPct: 0,
      maxDrawdownPct: 0,
    };
  }
  const returns = trades.map((t) => t.returnPct);
  const sorted = [...returns].sort((a, b) => a - b);
  const winning = trades.filter((t) => t.returnPct > 0).length;
  const losing = trades.filter((t) => t.returnPct < 0).length;
  const sum = returns.reduce((a, b) => a + b, 0);
  const median = (() => {
    const n = sorted.length;
    if (n === 0) return 0;
    const mid = Math.floor(n / 2);
    if (n % 2 === 1) return sorted[mid] ?? 0;
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  })();

  return {
    totalTrades: trades.length,
    winningTrades: winning,
    losingTrades: losing,
    hitRate: winning / trades.length,
    avgReturnPct: sum / trades.length,
    medianReturnPct: median,
    maxReturnPct: Math.max(...returns),
    minReturnPct: Math.min(...returns),
    maxDrawdownPct: Math.min(...trades.map((t) => t.maxDrawdownPct)),
  };
}
