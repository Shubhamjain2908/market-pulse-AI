import { describe, expect, it } from 'vitest';
import { isYahooMissingSymbolError } from '../../src/market/yahoo-errors.js';

describe('isYahooMissingSymbolError', () => {
  it('matches chart delisted/no-data message', () => {
    expect(isYahooMissingSymbolError(new Error('No data found, symbol may be delisted'))).toBe(true);
  });

  it('matches quoteSummary symbol not found message', () => {
    expect(isYahooMissingSymbolError(new Error('Quote not found for symbol: SGBJUN31I.NS'))).toBe(true);
  });

  it('does not match unrelated network errors', () => {
    expect(isYahooMissingSymbolError(new Error('ETIMEDOUT'))).toBe(false);
  });
});

