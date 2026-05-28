import { describe, expect, it } from 'vitest';
import {
  mapQuoteSummaryToSnapshot,
  normalizeDebtToEquity,
  toFiniteNumber,
} from '../../src/ingestors/yahoo-snapshot-ingestor.js';

describe('yahoo-snapshot-ingestor mapping', () => {
  it('normalizeDebtToEquity always divides by 100', () => {
    expect(normalizeDebtToEquity(45.2)).toBeCloseTo(0.452);
    expect(normalizeDebtToEquity(0)).toBe(0);
    expect(normalizeDebtToEquity(null)).toBeNull();
    expect(normalizeDebtToEquity('invalid')).toBeNull();
  });

  it('toFiniteNumber rejects non-finite values', () => {
    expect(toFiniteNumber(12.5)).toBe(12.5);
    expect(toFiniteNumber('3')).toBe(3);
    expect(toFiniteNumber(undefined)).toBeNull();
    expect(toFiniteNumber(Number.NaN)).toBeNull();
  });

  it('mapQuoteSummaryToSnapshot returns null when all fields missing', () => {
    expect(mapQuoteSummaryToSnapshot('RELIANCE', '2026-05-28', {})).toBeNull();
  });

  it('mapQuoteSummaryToSnapshot maps valuation fields', () => {
    const row = mapQuoteSummaryToSnapshot('reliance', '2026-05-28', {
      summaryDetail: {
        trailingPE: 25.1,
        marketCap: 1_800_000_000_000,
        dividendYield: 0.0035,
      },
      defaultKeyStatistics: { priceToBook: 2.1, trailingPegRatio: 1.4 },
      financialData: { returnOnEquity: 0.12, debtToEquity: 32.5 },
    });
    expect(row).toEqual({
      symbol: 'RELIANCE',
      asOf: '2026-05-28',
      pe: 25.1,
      pb: 2.1,
      peg: 1.4,
      marketCap: 1_800_000_000_000,
      dividendYield: 0.0035,
      roe: 0.12,
      debtToEquity: 0.325,
    });
  });

  it('mapQuoteSummaryToSnapshot falls back to price.trailingPE', () => {
    const row = mapQuoteSummaryToSnapshot('TCS', '2026-05-28', {
      price: { trailingPE: 30 },
      financialData: { debtToEquity: 10 },
    });
    expect(row?.pe).toBe(30);
    expect(row?.debtToEquity).toBeCloseTo(0.1);
  });
});
