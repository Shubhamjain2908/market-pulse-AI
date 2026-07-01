import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeDb,
  getDb,
  getLatestPromoterPledge,
  getPromoterPledgeQoQDelta,
  migrate,
  normalizeCompanyName,
  upsertPromoterPledgeRows,
} from '../../src/db/index.js';

describe('promoter_pledge queries', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-pledge-${Date.now()}.db`);
    process.env.DATABASE_PATH = dbPath;
    db = getDb({ path: dbPath });
    migrate(db);
  });

  afterEach(() => {
    db.close();
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(`${dbPath}${suffix}`);
      } catch {
        // best effort
      }
    }
  });

  it('upserts and reads latest pledge as of date', () => {
    upsertPromoterPledgeRows(
      [
        {
          symbol: 'RELIANCE',
          shpDate: '2026-03-31',
          pctSharesPledged: 0,
          pctPromoterHolding: 50,
          numSharesPledged: 0,
        },
        {
          symbol: 'RELIANCE',
          shpDate: '2026-06-30',
          pctSharesPledged: 12.5,
          pctPromoterHolding: 49,
          numSharesPledged: 1000,
        },
      ],
      db,
    );
    const latest = getLatestPromoterPledge('RELIANCE', '2026-07-01', db);
    expect(latest?.shpDate).toBe('2026-06-30');
    expect(latest?.pctSharesPledged).toBe(12.5);

    const older = getLatestPromoterPledge('RELIANCE', '2026-04-01', db);
    expect(older?.shpDate).toBe('2026-03-31');
  });

  it('computes QoQ pledge delta from two filings', () => {
    upsertPromoterPledgeRows(
      [
        {
          symbol: 'TCS',
          shpDate: '2026-03-31',
          pctSharesPledged: 5,
          pctPromoterHolding: null,
          numSharesPledged: null,
        },
        {
          symbol: 'TCS',
          shpDate: '2026-06-30',
          pctSharesPledged: 18,
          pctPromoterHolding: null,
          numSharesPledged: null,
        },
      ],
      db,
    );
    const qoq = getPromoterPledgeQoQDelta('TCS', '2026-07-01', db);
    expect(qoq).toEqual({ latest: 18, prior: 5, delta: 13 });
  });

  it('normalizes company names for matching', () => {
    expect(normalizeCompanyName('Reliance Industries Limited')).toBe('relianceindustries');
    expect(normalizeCompanyName('Tata Consultancy Services Ltd.')).toBe('tataconsultancyservices');
  });
});
