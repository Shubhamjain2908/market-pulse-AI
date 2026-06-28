import { describe, expect, it } from 'vitest';
import {
  computeWeinsteinStage,
  WEINSTEIN_STAGE,
  weinsteinStageLabel,
} from '../../src/enrichers/technical/weinstein-stage.js';

function uptrendCloses(n: number, start = 100, step = 0.5): number[] {
  return Array.from({ length: n }, (_, i) => start + i * step);
}

/** Peak-then-pullback below a high 200DMA (PAYTM Jun-2026 shape on Yahoo EOD). */
function peakThenPullbackCloses(flatBars: number, flatPx: number, dropBars: number): number[] {
  const flat = Array.from({ length: flatBars }, () => flatPx);
  const pullback = Array.from(
    { length: dropBars },
    (_, i) => flatPx - (i + 1) * ((flatPx * 0.06) / dropBars),
  );
  return [...flat, ...pullback];
}

describe('computeWeinsteinStage', () => {
  it('returns insufficient when fewer than 50 bars', () => {
    const r = computeWeinsteinStage(uptrendCloses(40), 39);
    expect(r.stageCode).toBe(WEINSTEIN_STAGE.INSUFFICIENT);
    expect(r.pctAboveSma200).toBeNull();
  });

  it('labels a steady uptrend as Stage 2B', () => {
    const closes = uptrendCloses(260);
    const r = computeWeinsteinStage(closes, closes.length - 1);
    expect(r.stageCode).toBe(WEINSTEIN_STAGE.STAGE_2B);
    expect(r.stageScore).toBe(30);
    expect(r.pctAboveSma200).not.toBeNull();
    expect(r.sma200Slope30dPct).not.toBeNull();
    if (r.pctAboveSma200 != null) expect(r.pctAboveSma200).toBeGreaterThan(0);
  });

  it('labels a steady downtrend as Stage 4', () => {
    const closes = uptrendCloses(260, 300, -0.6);
    const r = computeWeinsteinStage(closes, closes.length - 1);
    expect(r.stageCode).toBe(WEINSTEIN_STAGE.STAGE_4);
    expect(r.stageScore).toBe(0);
  });

  it('labels post-peak pullback below 200DMA as Stage 3/4 not 2B', () => {
    const closes = peakThenPullbackCloses(230, 1200, 30);
    const r = computeWeinsteinStage(closes, closes.length - 1);
    expect(r.stageCode).not.toBe(WEINSTEIN_STAGE.STAGE_2B);
    expect([WEINSTEIN_STAGE.STAGE_3, WEINSTEIN_STAGE.STAGE_4]).toContain(r.stageCode);
    expect(r.pctAboveSma200).not.toBeNull();
    if (r.pctAboveSma200 != null) expect(r.pctAboveSma200).toBeLessThan(0);
  });

  it('maps stage codes to labels', () => {
    expect(weinsteinStageLabel(WEINSTEIN_STAGE.STAGE_2B)).toBe('Stage 2B');
    expect(weinsteinStageLabel(0)).toBe('Insufficient data');
  });
});
