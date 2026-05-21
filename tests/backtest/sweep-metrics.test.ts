import { describe, expect, it } from 'vitest';
import { computePhase1SweepRow } from '../../src/backtest/sweep-metrics.js';
import type { ClosedSimTrade } from '../../src/backtest/types.js';

function trade(partial: Partial<ClosedSimTrade> & Pick<ClosedSimTrade, 'returnPct'>): ClosedSimTrade {
  return {
    symbol: 'AAA',
    entryDate: '2024-10-15',
    entryPrice: 100,
    exitDate: '2025-01-15',
    exitPrice: 105,
    maxDrawdownPct: -2,
    holdDays: 10,
    exitReason: 'TIME_EXIT',
    ...partial,
  };
}

describe('computePhase1SweepRow', () => {
  it('uses ISO string literals for bear sub-window profit factor', () => {
    const trades: ClosedSimTrade[] = [
      trade({ returnPct: 5, entryDate: '2024-10-01', exitDate: '2026-03-31' }),
      trade({ returnPct: -2, entryDate: '2024-10-15', exitDate: '2026-03-15' }),
      trade({ returnPct: 3, entryDate: '2024-09-30', exitDate: '2026-03-31' }),
      trade({ returnPct: 3, entryDate: '2024-10-02', exitDate: '2026-04-01' }),
    ];
    const row = computePhase1SweepRow(2.5, trades);
    expect(row.bearSubWindowPf).toBeCloseTo(5 / 2, 5);
    expect(row.totalTrades).toBe(4);
  });
});
