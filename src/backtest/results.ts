/**
 * Aggregate Option A closed trades into `backtest_runs` row shape + extended metrics.
 */

import type { OptionABacktestRunInsert } from '../db/backtest-queries.js';
import { type Trade, aggregate } from './metrics.js';
import type { ClosedSimTrade } from './types.js';

function toMetricTrades(trades: ClosedSimTrade[]): Trade[] {
  return trades.map((t) => ({
    symbol: t.symbol,
    entryDate: t.entryDate,
    entryPrice: t.entryPrice,
    exitDate: t.exitDate,
    exitPrice: t.exitPrice,
    returnPct: t.returnPct,
    maxDrawdownPct: t.maxDrawdownPct,
    holdDays: t.holdDays,
  }));
}

function expectancyAndExtras(trades: Trade[]): {
  expectancy: number;
  profitFactor: number;
  avgHoldDays: number;
} {
  if (trades.length === 0) {
    return { expectancy: 0, profitFactor: 0, avgHoldDays: 0 };
  }
  const wins = trades.filter((t) => t.returnPct > 0);
  const losses = trades.filter((t) => t.returnPct < 0);
  const hitRate = wins.length / trades.length;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.returnPct, 0) / wins.length : 0;
  const avgLossMag = losses.length
    ? losses.reduce((s, t) => s + Math.abs(t.returnPct), 0) / losses.length
    : 0;
  const expectancy = hitRate * avgWin - (1 - hitRate) * avgLossMag;

  const sumWin = wins.reduce((s, t) => s + t.returnPct, 0);
  const sumLossAbs = losses.reduce((s, t) => s + Math.abs(t.returnPct), 0);
  const profitFactor = sumLossAbs < 1e-9 ? (sumWin > 0 ? 999 : 0) : sumWin / sumLossAbs;

  const avgHoldDays = trades.reduce((s, t) => s + t.holdDays, 0) / trades.length;

  return { expectancy, profitFactor, avgHoldDays };
}

export function buildOptionARunRow(input: {
  strategyId: string;
  from: string;
  to: string;
  holdDays: number;
  universe: string[];
  trades: ClosedSimTrade[];
  costBpsRoundTrip: number;
  notes: string | null;
}): OptionABacktestRunInsert {
  const mt = toMetricTrades(input.trades);
  const m = aggregate(mt);
  const x = expectancyAndExtras(mt);
  return {
    strategyId: input.strategyId,
    screenName: `OPTION_A:${input.strategyId}`,
    startDate: input.from,
    endDate: input.to,
    holdDays: input.holdDays,
    symbolsCount: input.universe.length,
    totalTrades: m.totalTrades,
    winningTrades: m.winningTrades,
    losingTrades: m.losingTrades,
    hitRate: m.hitRate,
    avgReturnPct: m.avgReturnPct,
    medianReturnPct: m.medianReturnPct,
    maxReturnPct: m.maxReturnPct,
    minReturnPct: m.minReturnPct,
    maxDrawdownPct: m.maxDrawdownPct,
    expectancy: x.expectancy,
    avgHoldDays: x.avgHoldDays,
    profitFactor: x.profitFactor,
    universeJson: JSON.stringify(input.universe),
    costBpsRoundTrip: input.costBpsRoundTrip,
    notes: input.notes,
  };
}

export function tradesToDbRows(trades: ClosedSimTrade[]) {
  return trades.map((t) => ({
    symbol: t.symbol,
    entryDate: t.entryDate,
    entryPrice: t.entryPrice,
    exitDate: t.exitDate,
    exitPrice: t.exitPrice,
    returnPct: t.returnPct,
    maxDrawdownPct: t.maxDrawdownPct,
    holdDays: t.holdDays,
    exitReason: t.exitReason,
  }));
}
