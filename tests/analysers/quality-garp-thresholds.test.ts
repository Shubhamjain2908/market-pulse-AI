import { describe, expect, it } from 'vitest';
import {
  OPM_STD_DEV_MAX_PCT,
  QUALITY_GARP_DE_MAX,
  QUALITY_GARP_PB_MAX,
  QUALITY_GARP_PE_MAX,
  QUALITY_GARP_PEG_MAX,
  QUALITY_GARP_ROCE_MIN,
  QUALITY_GARP_ROE_MIN,
  QUALITY_GARP_RSI_MAX,
  QUALITY_GARP_SMA50_PCT_MAX,
  resolveGarpThresholds,
} from '../../src/analysers/quality-garp.js';

describe('resolveGarpThresholds', () => {
  it('BULL_TRENDING relaxes RSI to 55, PE to 40, PEG to 1.4, SMA50 to 8%', () => {
    const t = resolveGarpThresholds('BULL_TRENDING');
    expect(t.rsiMax).toBe(55);
    expect(t.peMax).toBe(40);
    expect(t.pegMax).toBe(1.4);
    expect(t.sma50PctMax).toBe(8);
  });

  it('BEAR_TRENDING tightens RSI to 40, PE to 28, PEG to 1.0, SMA50 to 3%', () => {
    const t = resolveGarpThresholds('BEAR_TRENDING');
    expect(t.rsiMax).toBe(40);
    expect(t.peMax).toBe(28);
    expect(t.pegMax).toBe(1.0);
    expect(t.sma50PctMax).toBe(3);
  });

  it('CRISIS tightens RSI to 35, PE to 22, PEG to 0.9, SMA50 to 0%', () => {
    const t = resolveGarpThresholds('CRISIS');
    expect(t.rsiMax).toBe(35);
    expect(t.peMax).toBe(22);
    expect(t.pegMax).toBe(0.9);
    expect(t.sma50PctMax).toBe(0);
  });

  it('CHOPPY (default/undefined) returns existing baseline constants', () => {
    const t = resolveGarpThresholds(undefined);
    expect(t.rsiMax).toBe(QUALITY_GARP_RSI_MAX); // 45
    expect(t.peMax).toBe(QUALITY_GARP_PE_MAX); // 35
    expect(t.pegMax).toBe(QUALITY_GARP_PEG_MAX); // 1.2
    expect(t.sma50PctMax).toBe(QUALITY_GARP_SMA50_PCT_MAX); // 5
  });

  it('CHOPPY explicitly returns same as undefined', () => {
    const t = resolveGarpThresholds('CHOPPY');
    const tUndef = resolveGarpThresholds(undefined);
    expect(t).toEqual(tUndef);
  });

  it('keeps fundamental floors constant across all regimes', () => {
    for (const regime of ['BULL_TRENDING', 'BEAR_TRENDING', 'CRISIS', 'CHOPPY'] as const) {
      const t = resolveGarpThresholds(regime);
      expect(t.pbMax).toBe(QUALITY_GARP_PB_MAX); // 6
      expect(t.roeMin).toBe(QUALITY_GARP_ROE_MIN); // 0.18
      expect(t.roceMin).toBe(QUALITY_GARP_ROCE_MIN); // 0.20
      expect(t.deMax).toBe(QUALITY_GARP_DE_MAX); // 0.5
      expect(t.opmStdDevMax).toBe(OPM_STD_DEV_MAX_PCT); // 5.0
    }
  });
});
