import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordPaperTrades } from '../../src/briefing/paper-trade-writer.js';
import type { PortfolioSummary, ThesisCard } from '../../src/briefing/template.js';
import { closeDb, getDb, migrate } from '../../src/db/index.js';
import { getOpenPaperTrades, insertPaperTradeIfAbsent } from '../../src/db/queries.js';

describe('recordPaperTrades', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-ptw-${Date.now()}.db`);
    process.env.DATABASE_PATH = dbPath;
    db = getDb({ path: dbPath });
    migrate(db);
  });

  afterEach(() => {
    db.close();
    closeDb();
    try {
      rmSync(dbPath);
    } catch {
      /* best effort */
    }
  });

  it('inserts AI_PICK from thesis cards with valid levels', () => {
    const theses: ThesisCard[] = [
      {
        symbol: 'ABCD',
        thesis: 'x',
        bullCase: ['a'],
        bearCase: ['b'],
        entryZone: '₹100–₹110',
        stopLoss: '₹95',
        target: '₹120',
        timeHorizon: 'short',
        confidence: 7,
        triggerReason: 'test',
      },
    ];
    const r = recordPaperTrades('2026-05-01', theses, undefined, db);
    expect(r.insertedAiPick).toBe(1);
    const open = getOpenPaperTrades(db);
    expect(open).toHaveLength(1);
    expect(open[0]?.signalType).toBe('AI_PICK');
    expect(open[0]?.maxHoldDays).toBe(30);
  });

  it('inserts PORTFOLIO_ADD when action is ADD and levels are numeric', () => {
    const portfolio: PortfolioSummary = {
      totalValue: 1,
      totalPnl: 0,
      totalPnlPct: 0,
      dayChange: null,
      dayChangePct: null,
      source: 'manual',
      positions: [
        {
          symbol: 'INFY',
          qty: 1,
          avgPrice: 100,
          lastPrice: 150,
          pnl: null,
          pnlPct: null,
          dayChangePct: null,
          action: 'ADD',
          conviction: 0.8,
          thesis: null,
          triggerReason: null,
          bullPoints: [],
          bearPoints: [],
          suggestedStop: 140,
          suggestedTarget: 180,
        },
      ],
    };
    const r = recordPaperTrades('2026-05-01', [], portfolio, db);
    expect(r.insertedPortfolioAdd).toBe(1);
    const o = getOpenPaperTrades(db);
    expect(o).toHaveLength(1);
    expect(o[0]?.signalType).toBe('PORTFOLIO_ADD');
    expect(o[0]?.maxHoldDays).toBe(90);
  });

  it('skips invalid long setup (target <= entry)', () => {
    const theses: ThesisCard[] = [
      {
        symbol: 'BAD',
        thesis: 'x',
        bullCase: ['a'],
        bearCase: ['b'],
        entryZone: '₹100',
        stopLoss: '₹95',
        target: '₹90',
        timeHorizon: 'medium',
        confidence: 5,
        triggerReason: 't',
      },
    ];
    expect(recordPaperTrades('2026-05-01', theses, undefined, db).insertedAiPick).toBe(0);
    expect(getOpenPaperTrades(db)).toHaveLength(0);
  });

  it('is idempotent for same source day', () => {
    insertPaperTradeIfAbsent(
      {
        symbol: 'ZZ',
        signalType: 'AI_PICK',
        sourceDate: '2026-05-01',
        entryPrice: 100,
        stopLoss: 90,
        target: 120,
        timeHorizon: 'medium',
        maxHoldDays: 90,
      },
      db,
    );
    const theses: ThesisCard[] = [
      {
        symbol: 'ZZ',
        thesis: 'x',
        bullCase: ['a'],
        bearCase: ['b'],
        entryZone: '₹100',
        stopLoss: '₹90',
        target: '₹120',
        timeHorizon: 'medium',
        confidence: 5,
        triggerReason: 't',
      },
    ];
    expect(recordPaperTrades('2026-05-01', theses, undefined, db).insertedAiPick).toBe(0);
    expect(getOpenPaperTrades(db)).toHaveLength(1);
  });
});
