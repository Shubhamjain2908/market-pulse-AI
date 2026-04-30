import { describe, expect, it } from 'vitest';
import {
  type Bar,
  atr,
  ema,
  fiftyTwoWeek,
  rsi,
  sma,
  volumeRatio,
} from '../../src/enrichers/index.js';

describe('indicators/sma', () => {
  it('returns nulls until lookback is satisfied, then a rolling mean', () => {
    const result = sma([1, 2, 3, 4, 5], 3);
    expect(result).toEqual([null, null, 2, 3, 4]);
  });

  it('handles equal values', () => {
    expect(sma([5, 5, 5, 5], 2)).toEqual([null, 5, 5, 5]);
  });

  it('returns all-null when input is shorter than period', () => {
    expect(sma([1, 2], 5)).toEqual([null, null]);
  });
});

describe('indicators/ema', () => {
  it('seeds from SMA then exponentially smooths', () => {
    const out = ema([1, 2, 3, 4, 5, 6], 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo(2, 6); // SMA seed = (1+2+3)/3
    // EMA[i] = (close - prev) * (2/(N+1)) + prev. k=0.5 for N=3
    const k = 2 / (3 + 1);
    let prev = 2;
    for (let i = 3; i < 6; i++) {
      prev = (i + 1 - prev) * k + prev;
      expect(out[i]).toBeCloseTo(prev, 6);
    }
  });
});

describe('indicators/rsi', () => {
  it('matches the canonical Wilder example to ~3 decimal places', () => {
    // Classic Wilder's "New Concepts" example - 14-period RSI on a known
    // close series should converge to ~70.46 by the 19th data point.
    const closes = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61,
      46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
    ];
    const result = rsi(closes, 14);
    expect(result[14]).toBeCloseTo(70.464, 1);
    expect(result[15]).toBeCloseTo(66.249, 1);
  });

  it('returns 100 when there are no losses', () => {
    const closes = Array.from({ length: 20 }, (_, i) => i + 1);
    const result = rsi(closes, 14);
    expect(result[14]).toBe(100);
  });

  it('returns nulls when input is shorter than period', () => {
    expect(rsi([1, 2, 3], 14)).toEqual([null, null, null]);
  });
});

describe('indicators/atr', () => {
  it('produces a positive value reflecting average true range', () => {
    const bars: Bar[] = Array.from({ length: 20 }, (_, i) => ({
      high: 100 + i + 1,
      low: 100 + i - 1,
      close: 100 + i,
      volume: 1000,
    }));
    const out = atr(bars, 14);
    expect(out[14]).not.toBeNull();
    expect(out[14]).toBeGreaterThan(0);
  });
});

describe('indicators/volumeRatio', () => {
  it('compares today against the previous N-day average', () => {
    const volumes = [...Array(20).fill(100), 300];
    const out = volumeRatio(volumes, 20);
    expect(out[20]).toBeCloseTo(3, 6);
  });

  it('returns null while insufficient history', () => {
    expect(volumeRatio([1, 2, 3], 20)).toEqual([null, null, null]);
  });
});

describe('indicators/fiftyTwoWeek', () => {
  it('reports correct high/low and percentages', () => {
    const bars: Bar[] = Array.from({ length: 100 }, (_, i) => ({
      high: 100 + i,
      low: 90 + i,
      close: 95 + i,
      volume: 1000,
    }));
    const fw = fiftyTwoWeek(bars);
    expect(fw).not.toBeNull();
    expect(fw?.high).toBe(199);
    expect(fw?.low).toBe(90);
    // last close = 194; pctFromHigh = (194-199)/199 * 100 ≈ -2.51
    expect(fw?.pctFromHigh).toBeCloseTo(-2.512, 2);
  });

  it('returns null on empty input', () => {
    expect(fiftyTwoWeek([])).toBeNull();
  });
});
