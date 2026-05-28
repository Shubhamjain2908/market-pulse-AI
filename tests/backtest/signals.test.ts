import { describe, expect, it } from 'vitest';
import {
  computeSignalsForLastBar,
  type OHLCVBar,
  SIGNAL_WINDOW_LEN,
} from '../../src/backtest/signals.js';

function linBars(start: string, n: number, startPx: number, step: number): OHLCVBar[] {
  const out: OHLCVBar[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const date = `${y}-${m}-${day}`;
    const px = startPx + i * step;
    out.push({
      date,
      open: px,
      high: px + 0.5,
      low: px - 0.5,
      close: px,
      volume: 1_000_000 + i * 1000,
      adjClose: px,
    });
  }
  return out;
}

describe('computeSignalsForLastBar', () => {
  it('returns SMA20 equal to mean of last 20 closes for a linear series', () => {
    const bars = linBars('2025-01-01', SIGNAL_WINDOW_LEN, 100, 0.1);
    const s = computeSignalsForLastBar(bars);
    expect(s).not.toBeNull();
    if (!s) return;
    const last20 = bars.slice(-20).map((b) => b.close);
    const mean20 = last20.reduce((a, b) => a + b, 0) / 20;
    expect(s.sma20).toBeCloseTo(mean20, 6);
  });

  it('returns null when fewer than SIGNAL_WINDOW_LEN bars', () => {
    const bars = linBars('2025-01-01', 100, 100, 0.1);
    expect(computeSignalsForLastBar(bars)).toBeNull();
  });
});
