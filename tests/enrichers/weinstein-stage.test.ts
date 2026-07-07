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

/**
 * Generate a close series from a normalized shape scaled by a multiplier.
 * Used by the scale-invariance test — the same shape at different price
 * magnitudes should produce identical stage classifications because all
 * thresholds are ratio-based (close/sma200, slope200/ma200, etc.).
 */
function scaleSeries(normalized: number[], scale: number): number[] {
  return normalized.map((v) => v * scale);
}

/**
 * A 260-bar shape with a gentle upward drift (slope200 > 0 but small) followed
 * by a flat plateau near the 200DMA. This exercises the normalized-slope
 * threshold `abs(slope200/ma200) < 0.005` used in Stage 1 detection.
 */
function normalizedShape(): number[] {
  const closes: number[] = [];
  // Gentle rise: 100 → 103 over 200 bars (~1.5% slope over SMA200)
  for (let i = 0; i < 200; i++) {
    closes.push(100 + i * (3 / 200));
  }
  // Flat plateau for 60 bars: holds near the 200DMA
  for (let i = 0; i < 60; i++) {
    closes.push(103);
  }
  return closes;
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

  it('is scale-invariant: identical stageCode for 50 vs 3000 price bases', () => {
    const normalized = normalizedShape();
    // 60× price difference: ₹52 (0.5×) vs ₹3,090 (30×)
    const cheap = scaleSeries(normalized, 0.5);
    const expensive = scaleSeries(normalized, 30);

    // Test across multiple indices in the lookback window
    const indices = [259, 240, 220, 200, 180, 150, 100, 80, 60, 51];
    for (const idx of indices) {
      const r1 = computeWeinsteinStage(cheap, idx);
      const r2 = computeWeinsteinStage(expensive, idx);
      expect(r1.stageCode).toBe(r2.stageCode);
      expect(r1.stageScore).toBe(r2.stageScore);
    }
  });

  it('maps stage codes to labels', () => {
    expect(weinsteinStageLabel(WEINSTEIN_STAGE.STAGE_2B)).toBe('Stage 2B');
    expect(weinsteinStageLabel(0)).toBe('Insufficient data');
  });
});
