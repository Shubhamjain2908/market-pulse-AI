import { describe, expect, it } from 'vitest';
import { skipScreenerFundamentalsFetch } from '../../src/market/screener-symbol-skip.js';

describe('skipScreenerFundamentalsFetch', () => {
  it('skips SGB tickers', () => {
    expect(skipScreenerFundamentalsFetch('SGBJUN31I-GB')).toBe(true);
  });

  it('skips benchmark and macro canonical symbols', () => {
    expect(skipScreenerFundamentalsFetch('NIFTY_50')).toBe(true);
    expect(skipScreenerFundamentalsFetch('USD_INR')).toBe(true);
    expect(skipScreenerFundamentalsFetch('DXY')).toBe(true);
  });

  it('does not skip normal equities', () => {
    expect(skipScreenerFundamentalsFetch('RELIANCE')).toBe(false);
    expect(skipScreenerFundamentalsFetch('NIFTYBEES')).toBe(false);
  });
});
