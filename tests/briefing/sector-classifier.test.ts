import { describe, expect, it } from 'vitest';
import { classifySector } from '../../src/briefing/sector-classifier.js';

describe('classifySector', () => {
  const explicit = { RELIANCE: 'Energy', INFY: 'IT' };

  it('uses explicit map entries first', () => {
    expect(classifySector('RELIANCE', explicit)).toBe('Energy');
    expect(classifySector('infy', explicit)).toBe('IT');
  });

  it('labels Sovereign Gold Bond tickers', () => {
    expect(classifySector('SGBAPR28I-GB', {})).toBe('Sovereign Gold Bond');
  });

  it('labels gold and silver ETF symbols', () => {
    expect(classifySector('GOLDBEES', {})).toBe('Gold ETF');
    expect(classifySector('GOLDCASE', {})).toBe('Gold ETF');
    expect(classifySector('SILVERBEES', {})).toBe('Silver ETF');
  });

  it('labels liquid fund ETFs', () => {
    expect(classifySector('LIQUIDCASE', {})).toBe('Liquid Fund');
    expect(classifySector('LIQUIDBEES', {})).toBe('Liquid Fund');
  });

  it('labels named index ETFs', () => {
    expect(classifySector('NIFTYBEES', {})).toBe('Index ETF');
    expect(classifySector('BANKBEES', {})).toBe('Index ETF');
    expect(classifySector('JUNIORBEES', {})).toBe('Index ETF');
  });

  it('falls back to Index ETF for generic BEES / ETF suffixes', () => {
    expect(classifySector('MIDCAPBEES', {})).toBe('Index ETF');
    expect(classifySector('SOMEETF', {})).toBe('Index ETF');
  });

  it('returns Unknown when unmatched', () => {
    expect(classifySector('ZZUNKNOWN', {})).toBe('Unknown');
  });
});
