import { describe, expect, it } from 'vitest';
import { normalizeFundamentalForScreen } from '../../src/analysers/signal-provider.js';

describe('normalizeFundamentalForScreen', () => {
  it('scales Yahoo-style decimal ROE/dividend to percent for screen DSL', () => {
    expect(normalizeFundamentalForScreen('roe', 0.17743)).toBeCloseTo(17.743, 3);
    expect(normalizeFundamentalForScreen('dividend_yield', 0.0201)).toBeCloseTo(2.01, 3);
    expect(normalizeFundamentalForScreen('roe', 17.7)).toBe(17.7);
    expect(normalizeFundamentalForScreen('pe', 22)).toBe(22);
  });
});
