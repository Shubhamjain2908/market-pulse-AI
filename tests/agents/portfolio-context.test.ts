import { describe, expect, it } from 'vitest';
import {
  CASH_PROXY_SYMBOL,
  computeInvestedPortfolioWeights,
  formatConcentrationContextLine,
  formatFundamentalsForLlm,
  isAllocationInstrument,
} from '../../src/agents/portfolio-context.js';
import type { PortfolioHoldingRow } from '../../src/db/index.js';

function holding(symbol: string, qty: number, price: number): PortfolioHoldingRow {
  return {
    symbol,
    exchange: 'NSE',
    asOf: '2026-06-25',
    qty,
    avgPrice: price,
    lastPrice: price,
    source: 'kite',
  };
}

describe('portfolio-context', () => {
  it('isAllocationInstrument uses etf-exclusions config', () => {
    expect(isAllocationInstrument('GOLDBEES')).toBe(true);
    expect(isAllocationInstrument('INFY')).toBe(false);
  });

  it('isAllocationInstrument catches SGB variants by prefix', () => {
    expect(isAllocationInstrument('SGBJUN31I-GB')).toBe(true);
    expect(isAllocationInstrument('SGBDE31III')).toBe(true);
    expect(isAllocationInstrument('SGBSOMETHING')).toBe(true);
  });

  it('computeInvestedPortfolioWeights excludes LIQUIDCASE from denominator', () => {
    const holdings = [
      holding(CASH_PROXY_SYMBOL, 100, 100),
      holding('PAYTM', 10, 1000),
      holding('INFY', 5, 2000),
    ];
    const { investedTotalInr, weightsPct } = computeInvestedPortfolioWeights(holdings);
    expect(investedTotalInr).toBe(20_000);
    expect(weightsPct.get('PAYTM')).toBeCloseTo(50, 1);
    expect(weightsPct.get('INFY')).toBeCloseTo(50, 1);
    expect(weightsPct.get(CASH_PROXY_SYMBOL)).toBeCloseTo(50, 1);
  });

  it('formatConcentrationContextLine flags soft and hard thresholds', () => {
    expect(formatConcentrationContextLine(9)).toBeNull();
    expect(formatConcentrationContextLine(12)).toContain('Soft limit 10%');
    expect(formatConcentrationContextLine(16)).toContain('hard 15%');
  });

  it('formatFundamentalsForLlm normalizes Yahoo decimal ROE', () => {
    const lines = formatFundamentalsForLlm({
      symbol: 'PAYTM',
      as_of: '2026-06-25',
      roe: 0.03558,
      pe: 130.94,
      source: 'yahoo_snapshot',
    });
    expect(lines.some((l) => l.startsWith('roe:') && l.includes('%'))).toBe(true);
    expect(lines.some((l) => l.includes('3.56%'))).toBe(true);
  });
});
