import { describe, expect, it } from 'vitest';
import { parseInrPriceMidpoint } from '../../src/briefing/paper-trade-parsers.js';

describe('parseInrPriceMidpoint', () => {
  it('parses a single value with rupee and commas', () => {
    expect(parseInrPriceMidpoint('₹2,400.50')).toBeCloseTo(2400.5, 4);
  });

  it('returns midpoint of a range', () => {
    expect(parseInrPriceMidpoint('₹2,400–₹2,450')).toBeCloseTo(2425, 4);
  });

  it('handles en-dash and hyphen ranges', () => {
    expect(parseInrPriceMidpoint('2400-2450')).toBe(2425);
  });

  it('returns null for empty or garbage', () => {
    expect(parseInrPriceMidpoint('')).toBeNull();
    expect(parseInrPriceMidpoint('n/a')).toBeNull();
  });
});
