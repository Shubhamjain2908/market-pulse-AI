import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyStrategyPortfolioGuardrails,
  getQualityGarpDeteriorationFlagsForSymbol,
} from '../../src/agents/portfolio-strategy-guardrails.js';
import { migrate } from '../../src/db/migrate.js';
import { upsertPromoterPledgeRows } from '../../src/db/queries.js';

const prevGate = process.env.QUALITY_GARP_PLEDGE_GATE;

function seedPledgeRows(db: Database.Database) {
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
}

describe('portfolio pledge deterioration flags', () => {
  beforeEach(() => {
    process.env.QUALITY_GARP_PLEDGE_GATE = '0';
    vi.resetModules();
  });

  afterEach(() => {
    if (prevGate === undefined) delete process.env.QUALITY_GARP_PLEDGE_GATE;
    else process.env.QUALITY_GARP_PLEDGE_GATE = prevGate;
    vi.resetModules();
  });

  it('excludes pledge flags from escalation when gate is off', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedPledgeRows(db);

    const flags = getQualityGarpDeteriorationFlagsForSymbol('RISE', '2026-05-28', db);
    expect(flags).not.toContain('promoter pledge rise');
    expect(flags).not.toContain('high promoter pledge');
  });

  it('does not escalate ADD to TRIM on pledge alone when gate is off', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedPledgeRows(db);

    const out = applyStrategyPortfolioGuardrails(
      {
        symbol: 'RISE',
        action: 'ADD',
        conviction: 0.7,
        thesis: 'Add on dip.',
        bullPoints: ['Quality'],
        bearPoints: ['Pledge risk'],
        triggerReason: 'LLM ADD thesis',
        suggestedStop: 90,
        suggestedTarget: 120,
      },
      {},
      { entrySource: 'unknown', symbol: 'RISE', date: '2026-05-28', db },
    );

    expect(out.action).toBe('ADD');
    expect(out.triggerReason).not.toContain('GUARDRAIL_OVERRIDE');
  });

  it('includes pledge in live flags when QUALITY_GARP_PLEDGE_GATE=1', async () => {
    process.env.QUALITY_GARP_PLEDGE_GATE = '1';
    vi.resetModules();

    const db = new Database(':memory:');
    migrate(db);
    seedPledgeRows(db);

    const { getQualityGarpDeteriorationFlagsForSymbol: liveFlags } = await import(
      '../../src/agents/portfolio-strategy-guardrails.js'
    );
    const flags = liveFlags('RISE', '2026-05-28', db);
    expect(flags).toContain('promoter pledge rise');
    expect(flags).toContain('high promoter pledge');
  });
});
