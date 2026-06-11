import { describe, expect, it } from 'vitest';
import { MODEL_COST_USD_PER_TOKEN } from '../../src/llm/provider.js';

describe('MODEL_COST_USD_PER_TOKEN', () => {
  it('includes gemini-3.1-pro-preview standard-tier rates', () => {
    const rates = MODEL_COST_USD_PER_TOKEN['gemini-3.1-pro-preview'];
    expect(rates).toBeDefined();
    expect(rates?.input).toBeCloseTo(2 / 1_000_000);
    expect(rates?.output).toBeCloseTo(12 / 1_000_000);
  });

  it('includes default vertex flash model', () => {
    expect(MODEL_COST_USD_PER_TOKEN['gemini-2.5-flash']).toBeDefined();
  });
});
