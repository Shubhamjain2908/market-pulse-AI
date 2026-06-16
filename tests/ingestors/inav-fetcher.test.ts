import { describe, expect, it, vi } from 'vitest';
import type { HttpClient } from '../../src/ingestors/base/http-client.js';
import type { NseEtfRowInput } from '../../src/ingestors/inav-fetcher.js';

vi.mock('../../src/ingestors/nse/cookie-jar.js', () => ({
  primeNseCookies: vi.fn().mockResolvedValue(undefined),
}));

import {
  computePremiumDiscountPct,
  fetchInavSnapshots,
  mapNseEtfRows,
  parseNseEtfApiResponse,
  pickNseEtfNavAndLast,
} from '../../src/ingestors/inav-fetcher.js';

describe('inav-fetcher', () => {
  it('computePremiumDiscountPct uses (last - inav) / inav * 100', () => {
    expect(computePremiumDiscountPct(100, 101)).toBeCloseTo(1, 5);
    expect(computePremiumDiscountPct(100, 99)).toBeCloseTo(-1, 5);
  });

  it('pickNseEtfNavAndLast prefers navValue/lastPrice then nav/ltP', () => {
    expect(pickNseEtfNavAndLast({ symbol: 'X', nav: '100', ltP: '101' })).toEqual({
      inav: 100,
      lastPrice: 101,
    });
    expect(
      pickNseEtfNavAndLast({
        symbol: 'X',
        navValue: '99',
        nav: '100',
        lastPrice: '100',
        ltP: '101',
      }),
    ).toEqual({ inav: 99, lastPrice: 100 });
    expect(pickNseEtfNavAndLast({ symbol: 'X' })).toEqual({ inav: null, lastPrice: null });
  });

  it('mapNseEtfRows accepts NSE nav/ltP aliases and skips rows without prices', () => {
    const universe = new Set(['NIFTYBEES', 'GOLDBEES']);
    const rows = mapNseEtfRows(
      [
        { symbol: 'NIFTYBEES', nav: '100', ltP: '100.6' },
        { symbol: 'GOLDBEES', nav: '50' },
        { symbol: 'SILVERBEES', nav: '80', ltP: '81' },
      ],
      universe,
      '2026-05-30',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.symbol).toBe('NIFTYBEES');
  });

  it('mapNseEtfRows filters to universe and parses numbers', () => {
    const universe = new Set(['NIFTYBEES', 'GOLDBEES']);
    const rows = mapNseEtfRows(
      [
        { symbol: 'NIFTYBEES', navValue: '100', lastPrice: '100.6' },
        { symbol: 'RELIANCE', navValue: 50, lastPrice: 51 },
        { symbol: 'GOLDBEES', navValue: 0, lastPrice: 10 },
      ],
      universe,
      '2026-05-30',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.symbol).toBe('NIFTYBEES');
    expect(rows[0]?.premiumDiscountPct).toBeCloseTo(0.6, 5);
  });

  it('parseNseEtfApiResponse accepts nav null without failing the envelope', () => {
    const rows = parseNseEtfApiResponse({
      timestamp: '01-Jun-2026 10:05:23',
      data: [
        { symbol: 'GOLDBEES', nav: '128.5109', ltP: '127.73', assets: 'Gold' },
        { symbol: 'LICMFGOLD', nav: null, ltP: '100' },
        { assets: 'Equity' },
      ],
    });
    expect(rows).not.toBeNull();
    expect(rows).toHaveLength(2);
    expect(pickNseEtfNavAndLast(rows?.[0] as NseEtfRowInput)).toEqual({
      inav: 128.5109,
      lastPrice: 127.73,
    });
    expect(pickNseEtfNavAndLast(rows?.[1] as NseEtfRowInput)).toEqual({
      inav: null,
      lastPrice: 100,
    });
  });

  it('fetchInavSnapshots fail-open on request error', async () => {
    const client = {
      request: vi.fn().mockRejectedValue(new Error('blocked')),
    } as unknown as HttpClient;
    const result = await fetchInavSnapshots({
      date: '2026-05-30',
      client,
      db: { prepare: () => ({ run: () => {} }), transaction: (fn: () => void) => fn() } as never,
    });
    expect(result.failed).toBe(true);
    expect(result.written).toBe(0);
  });
});
