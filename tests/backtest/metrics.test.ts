import { describe, expect, it } from 'vitest';
import { type Bar, aggregate, buildTrade } from '../../src/backtest/metrics.js';

describe('buildTrade', () => {
  const entry: Bar = { date: '2026-04-01', close: 100 };

  it('computes a simple positive return', () => {
    const fwd: Bar[] = [
      { date: '2026-04-02', close: 102 },
      { date: '2026-04-03', close: 105 },
      { date: '2026-04-04', close: 110 },
    ];
    const t = buildTrade('TEST', entry, fwd, 3);
    expect(t).not.toBeNull();
    if (!t) return;
    expect(t.exitDate).toBe('2026-04-04');
    expect(t.returnPct).toBeCloseTo(10);
    expect(t.maxDrawdownPct).toBe(0);
    expect(t.holdDays).toBe(3);
  });

  it('captures intraday drawdown during the hold', () => {
    const fwd: Bar[] = [
      { date: '2026-04-02', close: 95 },
      { date: '2026-04-03', close: 90 },
      { date: '2026-04-04', close: 105 },
    ];
    const t = buildTrade('TEST', entry, fwd, 3);
    if (!t) throw new Error('expected trade');
    expect(t.returnPct).toBeCloseTo(5);
    expect(t.maxDrawdownPct).toBeCloseTo(-10);
  });

  it('exits early when fewer bars than holdDays available', () => {
    const fwd: Bar[] = [{ date: '2026-04-02', close: 102 }];
    const t = buildTrade('TEST', entry, fwd, 5);
    if (!t) throw new Error('expected trade');
    expect(t.holdDays).toBe(1);
    expect(t.exitPrice).toBe(102);
  });

  it('returns null when no forward bars', () => {
    expect(buildTrade('TEST', entry, [], 5)).toBeNull();
  });

  it('returns null on zero/negative entry price', () => {
    expect(
      buildTrade('TEST', { date: '2026-04-01', close: 0 }, [{ date: '2026-04-02', close: 1 }], 1),
    ).toBeNull();
  });
});

describe('aggregate', () => {
  it('returns zeros for empty input', () => {
    const m = aggregate([]);
    expect(m.totalTrades).toBe(0);
    expect(m.hitRate).toBe(0);
    expect(m.avgReturnPct).toBe(0);
  });

  it('computes hit rate, mean, median across trades', () => {
    const trades = [mkTrade(2), mkTrade(-1), mkTrade(5), mkTrade(0.5), mkTrade(-3)];
    const m = aggregate(trades);
    expect(m.totalTrades).toBe(5);
    expect(m.winningTrades).toBe(3);
    expect(m.losingTrades).toBe(2);
    expect(m.hitRate).toBeCloseTo(3 / 5);
    expect(m.avgReturnPct).toBeCloseTo(0.7);
    expect(m.medianReturnPct).toBeCloseTo(0.5); // sorted: -3, -1, 0.5, 2, 5
    expect(m.maxReturnPct).toBe(5);
    expect(m.minReturnPct).toBe(-3);
  });

  it('median handles even-length arrays (avg of middle two)', () => {
    const m = aggregate([mkTrade(1), mkTrade(2), mkTrade(3), mkTrade(4)]);
    expect(m.medianReturnPct).toBeCloseTo(2.5);
  });

  it('max drawdown is the worst single-trade DD', () => {
    const m = aggregate([mkTrade(2, -3), mkTrade(5, -10), mkTrade(-1, -8)]);
    expect(m.maxDrawdownPct).toBe(-10);
  });
});

function mkTrade(
  returnPct: number,
  drawdown = 0,
): {
  symbol: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  returnPct: number;
  maxDrawdownPct: number;
  holdDays: number;
} {
  return {
    symbol: 'X',
    entryDate: '2026-04-01',
    entryPrice: 100,
    exitDate: '2026-04-10',
    exitPrice: 100 * (1 + returnPct / 100),
    returnPct,
    maxDrawdownPct: drawdown,
    holdDays: 10,
  };
}
