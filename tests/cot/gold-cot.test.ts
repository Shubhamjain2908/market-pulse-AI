import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildDisaggColumnMap,
  classifyCotGoldPosition,
  computeMmNetOiRatio,
  extractComexGoldFromDisaggFile,
  isComexGoldRow,
  parseCotGoldRow,
  parseCsvLine,
} from '../../src/cot/gold-cot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLD_LINE = readFileSync(join(__dirname, 'fixtures/gold-disagg-line.txt'), 'utf8').trim();

describe('gold-cot parser', () => {
  it('builds column map from canonical headers when file has no header row', () => {
    const cols = parseCsvLine(GOLD_LINE);
    const map = buildDisaggColumnMap(cols);
    expect(map).not.toBeNull();
    expect(map?.get('M_Money_Positions_Long_All')).toBe(13);
    expect(map?.get('Open_Interest_All')).toBe(7);
    expect(map?.get('CFTC_Market_Code_Quotes')).toBe(187);
  });

  it('identifies COMEX gold row (CMX exchange code)', () => {
    const cols = parseCsvLine(GOLD_LINE);
    const map = buildDisaggColumnMap(cols);
    expect(map).toBeDefined();
    if (!map) return;
    expect(isComexGoldRow(cols, map)).toBe(true);
  });

  it('rejects rows with unexpected column count (layout drift)', () => {
    const cols = parseCsvLine(GOLD_LINE);
    const map = buildDisaggColumnMap(cols);
    expect(map).toBeDefined();
    if (!map) return;
    const shortRow = cols.slice(0, 100);
    expect(parseCotGoldRow(shortRow, map)).toBeNull();
  });

  it('extracts managed-money net and ratio from live-format fixture', () => {
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

  it('classifies crowded long by net/OI and short only when mm_net < 0', () => {
    expect(classifyCotGoldPosition(100, 0.36)).toBe('CROWDED_LONG');
    expect(classifyCotGoldPosition(-1, 0.09)).toBe('CROWDED_SHORT');
    expect(classifyCotGoldPosition(100, 0.09)).toBe('NEUTRAL');
    expect(classifyCotGoldPosition(60, 0.2)).toBe('NEUTRAL');
  });
});
