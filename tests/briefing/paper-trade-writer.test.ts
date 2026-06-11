import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockError = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());
const noop = vi.hoisted(() => vi.fn());

vi.mock('../../src/logger.js', () => {
  const stub = () => ({
    warn: mockWarn,
    error: mockError,
    info: noop,
    debug: noop,
    child: stub,
  });
  const logger = stub();
  return { child: stub, logger };
});

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
    mockError.mockClear();
    mockWarn.mockClear();
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

  function aiPickThesis(
    symbol: string,
    entryZone: string,
    stopLoss: string,
    target: string,
  ): ThesisCard {
    return {
      symbol,
      thesis: 'x',
      bullCase: ['a'],
      bearCase: ['b'],
      entryZone,
      stopLoss,
      target,
      timeHorizon: 'medium',
      confidence: 7,
      triggerReason: 'test',
    };
  }

  it('rejects AI_PICK when stopLoss is above entryPrice', () => {
    const r = recordPaperTrades(
      '2026-05-01',
      [aiPickThesis('HIGH', '₹100', '₹105', '₹120')],
      undefined,
      db,
    );
    expect(r.insertedAiPick).toBe(0);
    expect(getOpenPaperTrades(db)).toHaveLength(0);
    expect(mockError).toHaveBeenCalledWith(
      { symbol: 'HIGH', stopLoss: 105, entryPrice: 100 },
      'AI_PICK paper trade rejected: stopLoss >= entryPrice',
    );
  });

  it('rejects AI_PICK when stopLoss equals entryPrice', () => {
    const r = recordPaperTrades(
      '2026-05-01',
      [aiPickThesis('FLAT', '₹100', '₹100', '₹120')],
      undefined,
      db,
    );
    expect(r.insertedAiPick).toBe(0);
    expect(getOpenPaperTrades(db)).toHaveLength(0);
    expect(mockError).toHaveBeenCalledWith(
      { symbol: 'FLAT', stopLoss: 100, entryPrice: 100 },
      'AI_PICK paper trade rejected: stopLoss >= entryPrice',
    );
  });

  it('raises AI_PICK stop to 8% hard floor when LLM stop is too wide', () => {
    const r = recordPaperTrades(
      '2026-05-01',
      [aiPickThesis('WIDE', '₹100', '₹88', '₹120')],
      undefined,
      db,
    );
    expect(r.insertedAiPick).toBe(1);
    const trade = getOpenPaperTrades(db)[0];
    expect(trade?.stopLoss).toBe(92);
    expect(mockWarn).toHaveBeenCalledWith(
      { symbol: 'WIDE', originalStop: 88, effectiveStop: 92 },
      'AI_PICK stop raised to 8% hard floor',
    );
  });

  it('inserts AI_PICK with LLM stop when above hard floor', () => {
    const r = recordPaperTrades(
      '2026-05-01',
      [aiPickThesis('OK', '₹100', '₹95', '₹120')],
      undefined,
      db,
    );
    expect(r.insertedAiPick).toBe(1);
    const trade = getOpenPaperTrades(db)[0];
    expect(trade?.stopLoss).toBe(95);
    expect(mockWarn).not.toHaveBeenCalledWith(
      expect.objectContaining({ originalStop: expect.any(Number) }),
      'AI_PICK stop raised to 8% hard floor',
    );
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
