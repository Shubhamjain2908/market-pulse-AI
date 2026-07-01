import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { getQualityGarpDeteriorationFlagsForSymbol } from '../../src/agents/portfolio-strategy-guardrails.js';
import { migrate } from '../../src/db/migrate.js';
import { upsertPromoterPledgeRows } from '../../src/db/queries.js';

describe('portfolio pledge deterioration flags', () => {
  it('flags QoQ pledge rise and high pledge level', () => {
    const db = new Database(':memory:');
    migrate(db);

    db.prepare(
      `
      INSERT INTO fundamentals (
        symbol, as_of, roe, roce, pe, pb, peg, debt_to_equity, source
      ) VALUES ('RISE', '2026-05-28', 0.2, 0.22, 20, 3, 1, 0.1, 'yahoo_snapshot')
    `,
    ).run();

    upsertPromoterPledgeRows(
      [
        {
          symbol: 'RISE',
          shpDate: '2025-12-31',
          pctSharesPledged: 10,
          pctPromoterHolding: 55,
          numSharesPledged: 100,
        },
        {
          symbol: 'RISE',
          shpDate: '2026-03-31',
          pctSharesPledged: 18,
          pctPromoterHolding: 55,
          numSharesPledged: 200,
        },
      ],
      db,
    );

    const flags = getQualityGarpDeteriorationFlagsForSymbol('RISE', '2026-05-28', db);
    expect(flags).toContain('promoter pledge rise');
    expect(flags).toContain('high promoter pledge');
  });
});
