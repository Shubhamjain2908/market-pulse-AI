import { describe, expect, it } from 'vitest';
import { computePositionWeightPct } from '../../src/strategies/position-sizer.js';

describe('position-sizer', () => {
  it('sizes from risk budget and stop distance', () => {
    // 1% of 10L, 80pt stop risk → 1.25% of book
    const w = computePositionWeightPct(100, 20, 1_000_000, 1, 5);
    expect(w).toBeCloseTo(1.25, 2);
  });

  it('caps at max_single_stock_pct', () => {
    const w = computePositionWeightPct(100, 99, 1_000_000, 1, 5);
    expect(w).toBe(5);
  });

  it('returns null when book is zero', () => {
    expect(computePositionWeightPct(100, 90, 0, 1, 5)).toBeNull();
  });

  it('returns null when stop is not below entry', () => {
    expect(computePositionWeightPct(100, 100, 1_000_000, 1, 5)).toBeNull();
  });
});
