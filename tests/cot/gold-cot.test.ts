import { describe, expect, it } from 'vitest';
import {
  classifyCotGoldRatio,
  computeMmNetOiRatio,
  extractComexGoldFromDisaggFile,
  isComexGoldRow,
  parseCsvLine,
} from '../../src/cot/gold-cot.js';

const GOLD_LINE =
  '"GOLD - COMMODITY EXCHANGE INC.",260526,2026-05-26,088691,CMX ,01,088 , 353489, 12586, 32096, 29033, 195289, 33022, 124277, 26831, 20369, 76427, 19613, 10626, 306340, 337846, 47149, 15643';

describe('gold-cot parser', () => {
  it('identifies COMEX gold row (CMX exchange code)', () => {
    const cols = parseCsvLine(GOLD_LINE);
    expect(isComexGoldRow(cols)).toBe(true);
  });

  it('extracts managed-money net and ratio from sample line', () => {
    const row = extractComexGoldFromDisaggFile(GOLD_LINE);
    expect(row).not.toBeNull();
    expect(row?.reportDate).toBe('2026-05-26');
    expect(row?.mmLong).toBe(124277);
    expect(row?.mmShort).toBe(26831);
    expect(row?.mmNet).toBe(124277 - 26831);
    expect(row?.openInterest).toBe(353489);
    expect(row?.mmNetOiRatio).toBeCloseTo(computeMmNetOiRatio(124277 - 26831, 353489), 5);
    expect(row?.classification).toBe('NEUTRAL');
  });

  it('classifies crowded long and short thresholds', () => {
    expect(classifyCotGoldRatio(0.36)).toBe('CROWDED_LONG');
    expect(classifyCotGoldRatio(0.09)).toBe('CROWDED_SHORT');
    expect(classifyCotGoldRatio(0.2)).toBe('NEUTRAL');
  });
});
