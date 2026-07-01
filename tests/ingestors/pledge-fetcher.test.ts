import { describe, expect, it } from 'vitest';
import { normalizeCompanyName } from '../../src/db/queries.js';
import {
  mapNsePledgeRows,
  type NsePledgeRowInput,
  parseNsePledgeApiResponse,
  parseNseShpDate,
} from '../../src/ingestors/nse/pledge-fetcher.js';

describe('pledge-fetcher', () => {
  it('parses padded pledge percentage strings', () => {
    const raw = [
      {
        comName: 'Reliance Industries Limited',
        percSharesPledged: '     0.00',
        percPromoterHolding: ' 50.50 ',
        numSharesPledged: ' 1000 ',
        shp: '30-Jun-2026',
      },
    ];
    const rows = parseNsePledgeApiResponse(raw);
    expect(rows).toHaveLength(1);
    if (!rows) throw new Error('expected rows');

    const nameToSymbol = new Map([
      [normalizeCompanyName('Reliance Industries Limited'), 'RELIANCE'],
    ]);
    const { mapped } = mapNsePledgeRows(rows, nameToSymbol);
    expect(mapped[0]).toMatchObject({
      symbol: 'RELIANCE',
      shpDate: '2026-06-30',
      pctSharesPledged: 0,
      pctPromoterHolding: 50.5,
      numSharesPledged: 1000,
    });
  });

  it('parses envelope with data array', () => {
    const raw = { data: [{ comName: 'TCS Ltd', percSharesPledged: 12, shp: '2026-03-31' }] };
    const rows = parseNsePledgeApiResponse(raw);
    expect(rows?.[0]?.comName).toBe('TCS Ltd');
  });

  it('parseNseShpDate handles DD-MMM-YYYY', () => {
    expect(parseNseShpDate('30-Jun-2026')).toBe('2026-06-30');
    expect(parseNseShpDate('2026-06-30')).toBe('2026-06-30');
  });

  it('skips unmatched company names', () => {
    const rows: NsePledgeRowInput[] = [
      { comName: 'Unknown Corp', percSharesPledged: 5, shp: '2026-06-30' },
    ];
    const { mapped, unmatched } = mapNsePledgeRows(rows, new Map());
    expect(mapped).toHaveLength(0);
    expect(unmatched).toEqual(['Unknown Corp']);
  });
});
