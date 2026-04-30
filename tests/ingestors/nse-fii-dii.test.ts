import { describe, expect, it, vi } from 'vitest';
import type { HttpClient } from '../../src/ingestors/base/http-client.js';
import { NseIngestor } from '../../src/ingestors/nse/ingestor.js';

/**
 * Build a minimal HttpClient stub that returns a canned NSE response.
 * Real-world payload sample:
 *   [{"category":"DII","date":"30-Apr-2026","buyValue":"18252.89", ...},
 *    {"category":"FII/FPI","date":"30-Apr-2026","buyValue":"15049.55", ...}]
 */
function stubClient(payload: unknown): HttpClient {
  return {
    name: 'nse-stub',
    got: vi.fn() as unknown as HttpClient['got'],
    cookieJar: undefined,
    acquire: vi.fn(async () => {}),
    request: vi.fn(async () => payload as never),
  };
}

describe('NseIngestor.fetchFiiDii', () => {
  it('merges FII and DII rows from the live response into a single record', async () => {
    const payload = [
      {
        category: 'DII',
        date: '30-Apr-2026',
        buyValue: '18252.89',
        sellValue: '14765.79',
        netValue: '3487.1',
      },
      {
        category: 'FII/FPI',
        date: '30-Apr-2026',
        buyValue: '15049.55',
        sellValue: '23097.41',
        netValue: '-8047.86',
      },
    ];
    const client = stubClient(payload);
    // Bypass cookie priming for the unit test.
    Object.assign(client, { acquire: vi.fn(async () => {}) });
    const ingestor = new NseIngestor(client);
    Object.assign(ingestor, { cookiesPrimed: true });

    const result = await ingestor.fetchFiiDii();
    expect(result.failed).toEqual([]);
    expect(result.data).toHaveLength(1);

    const row = result.data[0];
    expect(row).toBeDefined();
    expect(row?.date).toBe('2026-04-30');
    expect(row?.segment).toBe('cash');
    expect(row?.fiiBuy).toBeCloseTo(15049.55);
    expect(row?.fiiSell).toBeCloseTo(23097.41);
    expect(row?.fiiNet).toBeCloseTo(-8047.86);
    expect(row?.diiBuy).toBeCloseTo(18252.89);
    expect(row?.diiSell).toBeCloseTo(14765.79);
    expect(row?.diiNet).toBeCloseTo(3487.1);
  });

  it('coerces native-number values too (forward-compat)', async () => {
    const payload = [
      { category: 'FII/FPI', date: '01-May-2026', buyValue: 100, sellValue: 50, netValue: 50 },
      { category: 'DII', date: '01-May-2026', buyValue: 200, sellValue: 150, netValue: 50 },
    ];
    const client = stubClient(payload);
    const ingestor = new NseIngestor(client);
    Object.assign(ingestor, { cookiesPrimed: true });

    const result = await ingestor.fetchFiiDii();
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.fiiNet).toBe(50);
    expect(result.data[0]?.diiBuy).toBe(200);
  });

  it('returns empty data with failed=fii_dii when the response shape is invalid', async () => {
    const client = stubClient({ unexpected: 'shape' });
    const ingestor = new NseIngestor(client);
    Object.assign(ingestor, { cookiesPrimed: true });

    const result = await ingestor.fetchFiiDii();
    expect(result.data).toEqual([]);
    expect(result.failed).toEqual(['fii_dii']);
  });

  it('skips rows with non-finite numeric fields', async () => {
    const payload = [
      {
        category: 'FII/FPI',
        date: '01-May-2026',
        buyValue: 'NaN',
        sellValue: '50',
        netValue: '50',
      },
      { category: 'DII', date: '01-May-2026', buyValue: '200', sellValue: '150', netValue: '50' },
    ];
    const client = stubClient(payload);
    const ingestor = new NseIngestor(client);
    Object.assign(ingestor, { cookiesPrimed: true });

    const result = await ingestor.fetchFiiDii();
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.fiiBuy).toBe(0);
    expect(result.data[0]?.diiBuy).toBe(200);
  });
});
