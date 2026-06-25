import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PortfolioAction } from '../../src/agents/portfolio-analyser.js';
import { resolveHoldingEntrySource } from '../../src/agents/portfolio-entry-source.js';
import {
  applyCatalystPortfolioGuardrails,
  applyQualityGarpPortfolioGuardrails,
  assessCatalystHoldExpired,
  assessQualityGarpDeterioration,
} from '../../src/agents/portfolio-strategy-guardrails.js';
import { closeDb, getDb, insertPaperTradeIfAbsent, migrate } from '../../src/db/index.js';

function baseHold(symbol = 'ITC'): PortfolioAction {
  return {
    symbol,
    action: 'HOLD',
    conviction: 0.55,
    thesis: 'Hold line.',
    bullPoints: ['Trend'],
    bearPoints: ['Macro'],
    triggerReason: 'No change.',
    suggestedStop: null,
    suggestedTarget: null,
  };
}

describe('portfolio strategy guardrails', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-psg-${Date.now()}-${Math.random()}.db`);
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
        /* best effort */
      }
    }
  });

  describe('resolveHoldingEntrySource', () => {
    it('infers quality_garp from recent screen when no paper trade exists', () => {
      db.prepare(
        `INSERT INTO screens (symbol, date, screen_name, score, matched_criteria)
         VALUES ('INFY', '2026-06-20', 'quality_garp', 8, '{}')`,
      ).run();
      expect(resolveHoldingEntrySource('INFY', '2026-06-25', db)).toBe('quality_garp');
    });

    it('infers catalyst_entry from recent screen', () => {
      db.prepare(
        `INSERT INTO screens (symbol, date, screen_name, score, matched_criteria)
         VALUES ('TCS', '2026-06-18', 'catalyst_entry', 7, '{"days_to_earnings":10}')`,
      ).run();
      expect(resolveHoldingEntrySource('TCS', '2026-06-25', db)).toBe('catalyst_entry');
    });
  });

  describe('assessQualityGarpDeterioration', () => {
    it('flags promoter selling and profit decline', () => {
      const flags = assessQualityGarpDeterioration(
        {
          symbol: 'X',
          latestRoe: 0.2,
          prevRoe: 0.2,
          thirdRoe: 0.2,
          latestRoce: 0.25,
          latestRevGrowth: 10,
          pe: 20,
          pb: 3,
          peg: 1,
          debtToEquity: 0.2,
          marketCap: 1e12,
          promoterHoldingPct: 50,
          promoterHoldingChangeQoQ: -1,
        },
        -3,
      );
      expect(flags).toContain('promoter selling');
      expect(flags).toContain('profit decline');
    });
  });

  describe('applyQualityGarpPortfolioGuardrails', () => {
    it('forces EXIT on severe quality_garp deterioration', () => {
      db.prepare(
        `INSERT INTO fundamentals (symbol, as_of, source, profit_growth_yoy)
         VALUES ('QG', '2026-06-25', 'yahoo_annual', -4)`,
      ).run();
      const out = applyQualityGarpPortfolioGuardrails(baseHold('QG'), {
        entrySource: 'quality_garp',
        symbol: 'QG',
        date: '2026-06-25',
        db,
        qualityGarpBySymbol: new Map([
          [
            'QG',
            {
              symbol: 'QG',
              latestRoe: 0.2,
              prevRoe: 0.2,
              thirdRoe: 0.2,
              latestRoce: 0.25,
              latestRevGrowth: 10,
              pe: 20,
              pb: 3,
              peg: 1,
              debtToEquity: 0.2,
              marketCap: 1e12,
              promoterHoldingPct: 50,
              promoterHoldingChangeQoQ: -2,
            },
          ],
        ]),
        pnlPct: 5,
      });
      expect(out.action).toBe('EXIT');
      expect(out.triggerReason).toContain('GUARDRAIL_OVERRIDE');
    });
  });

  describe('catalyst hold window', () => {
    it('detects expired open catalyst paper trade', () => {
      insertPaperTradeIfAbsent(
        {
          symbol: 'CAT',
          signalType: 'catalyst_entry',
          sourceDate: '2026-06-01',
          entryPrice: 100,
          stopLoss: 96,
          target: 108,
          timeHorizon: 'short',
          maxHoldDays: 5,
          stopType: 'fixed',
          trailingMultiplier: 0,
        },
        db,
      );
      const r = assessCatalystHoldExpired('CAT', '2026-06-25', db);
      expect(r.expired).toBe(true);
      expect(r.daysPastMax).toBeGreaterThan(0);
    });

    it('trims catalyst_entry when hold window expired', () => {
      insertPaperTradeIfAbsent(
        {
          symbol: 'CAT2',
          signalType: 'catalyst_entry',
          sourceDate: '2026-06-01',
          entryPrice: 100,
          stopLoss: 96,
          target: 108,
          timeHorizon: 'short',
          maxHoldDays: 5,
          stopType: 'fixed',
          trailingMultiplier: 0,
        },
        db,
      );
      const out = applyCatalystPortfolioGuardrails(baseHold('CAT2'), {
        entrySource: 'catalyst_entry',
        symbol: 'CAT2',
        date: '2026-06-10',
        db,
        pnlPct: 2,
      });
      expect(out.action).toBe('TRIM');
      expect(out.triggerReason).toContain('Catalyst');
    });
  });
});
