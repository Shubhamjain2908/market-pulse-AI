import { describe, expect, it, vi } from 'vitest';
import type { HttpClient } from '../../src/ingestors/base/http-client.js';

vi.mock('../../src/ingestors/nse/cookie-jar.js', () => ({
  primeNseCookies: vi.fn().mockResolvedValue(undefined),
}));

import {
  computePremiumDiscountPct,
  fetchInavSnapshots,
  mapNseEtfRows,
} from '../../src/ingestors/inav-fetcher.js';

describe('inav-fetcher', () => {
  it('computePremiumDiscountPct uses (last - inav) / inav * 100', () => {
    expect(computePremiumDiscountPct(100, 101)).toBeCloseTo(1, 5);
    expect(computePremiumDiscountPct(100, 99)).toBeCloseTo(-1, 5);
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
