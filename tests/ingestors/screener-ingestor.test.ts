import { describe, expect, it } from 'vitest';
import { buildScreenerCompanyPaths } from '../../src/ingestors/screener/ingestor.js';

describe('buildScreenerCompanyPaths', () => {
  it('adds a base-symbol fallback for NSE series suffix symbols', () => {
    expect(buildScreenerCompanyPaths('KECL-BE')).toEqual([
      '/company/KECL-BE/consolidated/',
      '/company/KECL-BE/',
      '/company/KECL/consolidated/',
      '/company/KECL/',
    ]);
  });

  it('uses only the canonical symbol when there is no series suffix', () => {
    expect(buildScreenerCompanyPaths('RELIANCE')).toEqual([
      '/company/RELIANCE/consolidated/',
      '/company/RELIANCE/',
    ]);
  });
});
