import { describe, expect, it } from 'vitest';

import { buildRegimeProxyMap, computeRegimeProxyForDate } from '../../src/backtest/regime-proxy.js';
import type { OHLCVBar } from '../../src/backtest/signals.js';

function mkBar(date: string, close: number): OHLCVBar {
  return { date, open: close, high: close, low: close, close, volume: 1e6, adjClose: close };
}

/** `total` consecutive UTC calendar days from 2020-01-01, close rising 0.5 per day. */
function risingSeries(total: number, startClose = 100): OHLCVBar[] {
  const start = new Date('2020-01-01T00:00:00Z');
  const out: OHLCVBar[] = [];
  for (let i = 0; i < total; i++) {
    const dt = new Date(start);
    dt.setUTCDate(dt.getUTCDate() + i);
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const day = String(dt.getUTCDate()).padStart(2, '0');
    out.push(mkBar(`${y}-${m}-${day}`, startClose + i * 0.5));
  }
  return out;
}

describe('computeRegimeProxyForDate', () => {
  it('returns BULL when nifty vs SMA200 and slope positive and breadth > 50%', () => {
    const nifty = risingSeries(220, 100);
    const lastD = nifty.at(-1)?.date;
    expect(lastD).toBeDefined();
    if (!lastD) return;
    const stock = risingSeries(220, 50);
    const uni = new Map<string, OHLCVBar[]>([['STOCK1', stock]]);
    const r = computeRegimeProxyForDate(nifty, uni, ['STOCK1'], 'NIFTY_50', lastD);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.regime).toBe('BULL_TRENDING');
    expect(r.signalsPositive).toBe(3);
  });

  it('returns CHOPPY when breadth arm is not bullish', () => {
    const nifty = risingSeries(220, 100);
    const lastD = nifty.at(-1)?.date;
    expect(lastD).toBeDefined();
    if (!lastD) return;
    const flat = nifty.map((b) => mkBar(b.date, 100));
    const uni = new Map<string, OHLCVBar[]>([['STOCK1', flat]]);
    const r = computeRegimeProxyForDate(nifty, uni, ['STOCK1'], 'NIFTY_50', lastD);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.regime).toBe('CHOPPY');
  });
});

describe('buildRegimeProxyMap', () => {
  it('fills one entry per trading date', () => {
    const nifty = risingSeries(220);
    const dates = nifty.slice(-5).map((b) => b.date);
    const uni = new Map<string, OHLCVBar[]>([['A', risingSeries(220, 40)]]);
    const map = buildRegimeProxyMap(nifty, uni, dates, ['A'], 'NIFTY_50');
    expect(map.size).toBe(5);
  });
});
