import { describe, expect, it } from 'vitest';
import { evaluateCriterion, evaluateScreen } from '../../src/analysers/evaluator.js';
import { StaticSignalProvider } from '../../src/analysers/signal-provider.js';
import type { ScreenCriterion, ScreenDefinition } from '../../src/types/domain.js';

const symbol = 'TEST';
const date = '2026-04-30';

function provider(values: Record<string, number | null>): StaticSignalProvider {
  return new StaticSignalProvider(values);
}

describe('evaluator: literal operators', () => {
  const cases: Array<[ScreenCriterion['op'], number, number, boolean]> = [
    ['eq', 5, 5, true],
    ['eq', 5, 6, false],
    ['neq', 5, 6, true],
    ['neq', 5, 5, false],
    ['gt', 6, 5, true],
    ['gt', 5, 5, false],
    ['gte', 5, 5, true],
    ['gte', 4, 5, false],
    ['lt', 4, 5, true],
    ['lt', 5, 5, false],
    ['lte', 5, 5, true],
    ['lte', 6, 5, false],
  ];

  for (const [op, lhs, rhs, expected] of cases) {
    it(`${op}: ${lhs} ${op} ${rhs} -> ${expected}`, () => {
      const result = evaluateCriterion(
        { signal: 'x', op, value: rhs },
        symbol,
        date,
        provider({ x: lhs }),
      );
      expect(result.matched).toBe(expected);
      expect(result.lhs).toBe(lhs);
      expect(result.rhs).toBe(rhs);
    });
  }
});

describe('evaluator: between', () => {
  it('matches when value is in range (inclusive)', () => {
    const r = evaluateCriterion(
      { signal: 'rsi_14', op: 'between', value: [30, 70] },
      symbol,
      date,
      provider({ rsi_14: 50 }),
    );
    expect(r.matched).toBe(true);
    expect(r.rhs).toEqual([30, 70]);
  });

  it('matches at exact bounds', () => {
    expect(
      evaluateCriterion(
        { signal: 'x', op: 'between', value: [10, 20] },
        symbol,
        date,
        provider({ x: 10 }),
      ).matched,
    ).toBe(true);
    expect(
      evaluateCriterion(
        { signal: 'x', op: 'between', value: [10, 20] },
        symbol,
        date,
        provider({ x: 20 }),
      ).matched,
    ).toBe(true);
  });

  it('fails outside range', () => {
    expect(
      evaluateCriterion(
        { signal: 'x', op: 'between', value: [10, 20] },
        symbol,
        date,
        provider({ x: 9.99 }),
      ).matched,
    ).toBe(false);
  });

  it('returns invalid criterion when value is not a tuple', () => {
    const r = evaluateCriterion(
      { signal: 'x', op: 'between', value: 5 },
      symbol,
      date,
      provider({ x: 5 }),
    );
    expect(r.matched).toBe(false);
    expect(r.reason).toMatch(/tuple/);
  });
});

describe('evaluator: signal cross-comparison', () => {
  it('gt_signal: close > sma_50 — true', () => {
    const r = evaluateCriterion(
      { signal: 'close', op: 'gt_signal', value: 'sma_50' },
      symbol,
      date,
      provider({ close: 100, sma_50: 90 }),
    );
    expect(r.matched).toBe(true);
    expect(r.rhs).toEqual({ signal: 'sma_50', value: 90 });
  });

  it('gt_signal: equal values do not match', () => {
    const r = evaluateCriterion(
      { signal: 'close', op: 'gt_signal', value: 'sma_50' },
      symbol,
      date,
      provider({ close: 100, sma_50: 100 }),
    );
    expect(r.matched).toBe(false);
  });

  it('lt_signal: close < sma_200 — true', () => {
    const r = evaluateCriterion(
      { signal: 'close', op: 'lt_signal', value: 'sma_200' },
      symbol,
      date,
      provider({ close: 80, sma_200: 100 }),
    );
    expect(r.matched).toBe(true);
  });

  it('fails when rhs signal is missing', () => {
    const r = evaluateCriterion(
      { signal: 'close', op: 'gt_signal', value: 'sma_50' },
      symbol,
      date,
      provider({ close: 100 }),
    );
    expect(r.matched).toBe(false);
    expect(r.reason).toMatch(/rhs.*missing/);
  });
});

describe('evaluator: missing lhs', () => {
  it('always fails with reason when signal is missing', () => {
    const r = evaluateCriterion(
      { signal: 'rsi_14', op: 'gt', value: 70 },
      symbol,
      date,
      provider({}),
    );
    expect(r.matched).toBe(false);
    expect(r.lhs).toBeNull();
    expect(r.reason).toMatch(/missing/);
  });
});

describe('evaluator: full screen', () => {
  const screen: ScreenDefinition = {
    name: 'momentum_test',
    label: 'Momentum Test',
    description: 'test',
    timeHorizon: 'short',
    criteria: [
      { signal: 'rsi_14', op: 'between', value: [55, 75] },
      { signal: 'close', op: 'gt_signal', value: 'sma_50' },
      { signal: 'volume_ratio_20d', op: 'gte', value: 1.5 },
    ],
  };

  it('passes when all criteria match', () => {
    const e = evaluateScreen(
      screen,
      'AAA',
      date,
      provider({ rsi_14: 65, close: 110, sma_50: 100, volume_ratio_20d: 1.8 }),
    );
    expect(e.passed).toBe(true);
    expect(e.score).toBe(1);
    expect(e.matchedCount).toBe(3);
  });

  it('partial match yields 0 < score < 1', () => {
    const e = evaluateScreen(
      screen,
      'AAA',
      date,
      provider({ rsi_14: 65, close: 95, sma_50: 100, volume_ratio_20d: 1.8 }),
    );
    expect(e.passed).toBe(false);
    expect(e.matchedCount).toBe(2);
    expect(e.score).toBeCloseTo(2 / 3);
  });

  it('zero matches yields score=0', () => {
    const e = evaluateScreen(
      screen,
      'AAA',
      date,
      provider({ rsi_14: 30, close: 90, sma_50: 100, volume_ratio_20d: 0.5 }),
    );
    expect(e.passed).toBe(false);
    expect(e.score).toBe(0);
  });
});
