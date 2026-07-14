import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockError = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());
const mockInfo = vi.hoisted(() => vi.fn());
const noop = vi.hoisted(() => vi.fn());
const portfolioAddPaperTrades = vi.hoisted(() => ({ value: '0' as '0' | '1' }));

vi.mock('../../src/logger.js', () => {
  const stub = () => ({
    warn: mockWarn,
    error: mockError,
    info: mockInfo,
    debug: noop,
    child: stub,
  });
  const logger = stub();
  return { child: stub, logger };
});

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/config/env.js')>();
  return {
    ...mod,
    get config() {
      return { ...mod.config, PORTFOLIO_ADD_PAPER_TRADES: portfolioAddPaperTrades.value };
    },
  };
});

import { recordPaperTrades } from '../../src/briefing/paper-trade-writer.js';
import type { PortfolioSummary, ThesisCard } from '../../src/briefing/template.js';
import { closeDb, getDb, migrate, upsertHoldings } from '../../src/db/index.js';
import { getOpenPaperTrades, insertPaperTradeIfAbsent } from '../../src/db/queries.js';

describe('recordPaperTrades', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;

  function insertNiftyQuote(date: string): void {
    db.prepare(
      `INSERT INTO quotes (symbol, exchange, date, open, high, low, close, volume, source)
       VALUES ('NIFTY_50', 'NSE', ?, 100, 100, 100, 100, 1000, 'test')`,
    ).run(date);
  }

  const QUOTES = [
    '2026-04-27',
    '2026-04-28',
    '2026-04-29',
    '2026-04-30',
    '2026-05-01',
    '2026-07-03',
    '2026-07-06',
  ];

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-ptw-${Date.now()}.db`);
    process.env.DATABASE_PATH = dbPath;
    portfolioAddPaperTrades.value = '0';
    db = getDb({ path: dbPath });
    migrate(db);
    for (const d of QUOTES) {
      insertNiftyQuote(d);
    }
    mockError.mockClear();
    mockWarn.mockClear();
    mockInfo.mockClear();
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

  function seedPathAScreen(symbol: string, date: string): void {
    db.prepare(
      `
      INSERT INTO screens (symbol, date, screen_name, score, matched_criteria)
      VALUES (?, ?, 'rsi_oversold_bounce', 1, '{}')
    `,
    ).run(symbol, date);
    db.prepare(
      `INSERT INTO signals (symbol, date, name, value, source)
       VALUES (?, ?, 'mom_earnings_blackout', 0, 'test')`,
    ).run(symbol, date);
  }

  it('inserts AI_PICK from thesis cards with valid levels', () => {
    seedPathAScreen('ABCD', '2026-05-01');
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
    expect(open[0]?.positionWeightPct).toBeNull();
  });

  it('stamps position_weight_pct when book value is available', () => {
    upsertHoldings(
      [
        {
          symbol: 'LIQUID',
          exchange: 'NSE',
          asOf: '2026-05-01',
          qty: 100,
          avgPrice: 1000,
          lastPrice: 1000,
          source: 'kite',
        },
      ],
      db,
    );
    seedPathAScreen('SIZED', '2026-05-01');
    const r = recordPaperTrades(
      '2026-05-01',
      [
        {
          symbol: 'SIZED',
          thesis: 'x',
          bullCase: ['a'],
          bearCase: ['b'],
          entryZone: '₹100',
          stopLoss: '₹92',
          target: '₹120',
          timeHorizon: 'short',
          confidence: 7,
          triggerReason: 'test',
        },
      ],
      undefined,
      db,
    );
    expect(r.insertedAiPick).toBe(1);
    const w = getOpenPaperTrades(db)[0]?.positionWeightPct;
    expect(w).not.toBeNull();
    expect(w).toBeLessThanOrEqual(5);
  });

  it('logs aggregate sector cap exceeded but still inserts (shadow)', () => {
    for (let i = 1; i <= 5; i++) {
      const sym = `CAP${i}`;
      db.prepare(`INSERT INTO symbols (symbol, exchange, sector) VALUES (?, 'NSE', 'Banks')`).run(
        sym,
      );
      insertPaperTradeIfAbsent(
        {
          symbol: sym,
          signalType: 'momentum_mf',
          sourceDate: '2026-04-01',
          entryPrice: 100,
          stopLoss: 90,
          target: 120,
          timeHorizon: 'medium',
          maxHoldDays: 90,
          positionWeightPct: 2,
        },
        db,
      );
    }
    const sym = 'BANKNEW';
    db.prepare(`INSERT INTO symbols (symbol, exchange, sector) VALUES (?, 'NSE', 'Banks')`).run(
      sym,
    );
    seedPathAScreen(sym, '2026-05-01');
    const r = recordPaperTrades(
      '2026-05-01',
      [
        {
          symbol: sym,
          thesis: 'x',
          bullCase: ['a'],
          bearCase: ['b'],
          entryZone: '₹100',
          stopLoss: '₹92',
          target: '₹120',
          timeHorizon: 'short',
          confidence: 7,
          triggerReason: 'test',
        },
      ],
      undefined,
      db,
    );
    expect(r.insertedAiPick).toBe(1);
    expect(r.sectorCapExceeded).toBe(1);
    expect(getOpenPaperTrades(db).some((t) => t.symbol === sym)).toBe(true);
  });

  it('inserts PORTFOLIO_ADD when action is ADD and levels are numeric and flag enabled', () => {
    portfolioAddPaperTrades.value = '1';
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

  it('skips PORTFOLIO_ADD inserts by default', () => {
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
    expect(r.insertedPortfolioAdd).toBe(0);
    expect(r.blockedPortfolioAdd).toBe(1);
    expect(getOpenPaperTrades(db)).toHaveLength(0);
    expect(mockInfo).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'INFY', event: 'portfolio_add_paper_disabled' }),
      'PORTFOLIO_ADD paper trade disabled by config',
    );
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

  it('applies 8% floor backstop when LLM stop is too wide', () => {
    seedPathAScreen('WIDE', '2026-05-01');
    const r = recordPaperTrades(
      '2026-05-01',
      [aiPickThesis('WIDE', '₹100', '₹88', '₹120')],
      undefined,
      db,
    );
    expect(r.insertedAiPick).toBe(1);
    const trade = getOpenPaperTrades(db)[0];
    expect(trade?.stopLoss).toBe(92);
    expect(mockWarn).not.toHaveBeenCalledWith(
      expect.objectContaining({ originalStop: expect.any(Number) }),
      'AI_PICK stop raised to 8% hard floor',
    );
  });

  it('widens tight AI_PICK stop to minimum distance', () => {
    seedPathAScreen('TIGHT', '2026-05-01');
    db.prepare(
      `INSERT INTO signals (symbol, date, name, value, source) VALUES ('TIGHT', '2026-05-01', 'atr_14', 2.5, 'test')`,
    ).run();
    const r = recordPaperTrades(
      '2026-05-01',
      [aiPickThesis('TIGHT', '₹100', '₹99.5', '₹120')],
      undefined,
      db,
    );
    expect(r.insertedAiPick).toBe(1);
    const trade = getOpenPaperTrades(db)[0];
    expect(trade?.stopLoss).toBe(97.5);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ai_pick_stop_normalized', symbol: 'TIGHT' }),
      'AI_PICK stop widened to minimum distance',
    );
  });

  it('inserts AI_PICK with LLM stop when above hard floor', () => {
    seedPathAScreen('OK', '2026-05-01');
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

  function aiPickThesisCard(symbol: string): ThesisCard {
    return {
      symbol,
      thesis: 'x',
      bullCase: ['a'],
      bearCase: ['b'],
      entryZone: '₹100',
      stopLoss: '₹95',
      target: '₹120',
      timeHorizon: 'medium',
      confidence: 7,
      triggerReason: 't',
    };
  }

  it('blocks AI_PICK via eligibility gate when no confirmation path', () => {
    const r = recordPaperTrades('2026-05-01', [aiPickThesisCard('NOGATE')], undefined, db);
    expect(r.insertedAiPick).toBe(0);
    expect(r.blockedAiPick).toBe(1);
    expect(r.blockedAiPickDetails).toEqual([
      { symbol: 'NOGATE', reasons: ['earnings_blackout_unknown'] },
    ]);
    expect(mockInfo).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ai_pick_blocked', symbol: 'NOGATE' }),
      'AI_PICK blocked by eligibility gate',
    );
  });

  it('blocks AI_PICK when OPEN momentum_mf exists for the symbol', () => {
    seedPathAScreen('RELIANCE', '2026-05-01');
    db.prepare(
      `
      INSERT INTO paper_trades (
        symbol, signal_type, source_date, entry_price, stop_loss, target,
        time_horizon, max_hold_days, status
      ) VALUES ('RELIANCE', 'momentum_mf', '2026-04-01', 100, 92, 115, 'medium', 90, 'OPEN')
    `,
    ).run();
    const r = recordPaperTrades('2026-05-01', [aiPickThesisCard('RELIANCE')], undefined, db);
    expect(r.insertedAiPick).toBe(0);
    expect(r.crossStrategyBlocked).toBe(1);
    expect(getOpenPaperTrades(db)).toHaveLength(1);
    expect(mockInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'RELIANCE',
        signalType: 'AI_PICK',
        blockReason: 'open_in_other_strategy',
      }),
      'paper trade dedup — symbol already open under different signal',
    );
  });

  function catalystThesisCard(symbol: string): ThesisCard {
    return {
      symbol,
      thesis: 'Catalyst thesis with enough length for validation.',
      bullCase: ['a'],
      bearCase: ['b'],
      entryZone: '₹100',
      stopLoss: '₹95',
      target: '₹110',
      timeHorizon: 'short',
      confidence: 6,
      triggerReason: 'catalyst_entry',
    };
  }

  function seedCatalystScreen(symbol: string, date: string): void {
    db.prepare(
      `
      INSERT INTO screens (symbol, date, screen_name, score, matched_criteria)
      VALUES (?, ?, 'catalyst_entry', 1, ?)
    `,
    ).run(symbol, date, JSON.stringify({ days_to_earnings: 7, atr_14: 3.2 }));
  }

  it('keeps catalyst_entry exempt from the AI_PICK earnings blackout gate', () => {
    seedCatalystScreen('CATEARN', '2026-05-01');
    db.prepare(
      `INSERT INTO signals (symbol, date, name, value, source)
       VALUES ('CATEARN', '2026-05-01', 'mom_earnings_blackout', 1, 'test')`,
    ).run();

    const r = recordPaperTrades('2026-05-01', [catalystThesisCard('CATEARN')], undefined, db);

    expect(r.insertedCatalystEntry).toBe(1);
    expect(r.blockedAiPickDetails).toEqual([]);
  });

  it('does not insert an AI_PICK when earnings blackout is active', () => {
    const date = '2026-07-06';
    db.prepare(
      `INSERT INTO screens (symbol, date, screen_name, score, matched_criteria)
       VALUES ('LTF', ?, 'volume_breakout', 1, '{}')`,
    ).run(date);
    db.prepare(
      `INSERT INTO signals (symbol, date, name, value, source)
       VALUES ('LTF', ?, 'mom_earnings_blackout', 1, 'test')`,
    ).run(date);

    const r = recordPaperTrades(date, [aiPickThesisCard('LTF')], undefined, db);

    expect(r.insertedAiPick).toBe(0);
    expect(r.blockedAiPickDetails).toEqual([{ symbol: 'LTF', reasons: ['earnings_blackout'] }]);
    expect(getOpenPaperTrades(db)).toHaveLength(0);
  });

  it('blocks catalyst_entry when another OPEN paper trade exists for the symbol', () => {
    seedCatalystScreen('CATBLK', '2026-05-01');
    db.prepare(
      `
      INSERT INTO paper_trades (
        symbol, signal_type, source_date, entry_price, stop_loss, target,
        time_horizon, max_hold_days, status
      ) VALUES ('CATBLK', 'AI_PICK', '2026-04-01', 100, 95, 120, 'medium', 90, 'OPEN')
    `,
    ).run();
    const r = recordPaperTrades('2026-05-01', [catalystThesisCard('CATBLK')], undefined, db);
    expect(r.insertedCatalystEntry).toBe(0);
    expect(r.crossStrategyBlocked).toBe(1);
    expect(getOpenPaperTrades(db)).toHaveLength(1);
    expect(mockInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'CATBLK',
        signalType: 'catalyst_entry',
        blockReason: 'open_in_other_strategy',
      }),
      'paper trade dedup — symbol already open under different signal',
    );
  });

  it('blocks PORTFOLIO_ADD when another OPEN paper trade exists for the symbol', () => {
    portfolioAddPaperTrades.value = '1';
    db.prepare(
      `
      INSERT INTO paper_trades (
        symbol, signal_type, source_date, entry_price, stop_loss, target,
        time_horizon, max_hold_days, status
      ) VALUES ('ADDBLK', 'momentum_mf', '2026-04-01', 100, 92, 115, 'medium', 90, 'OPEN')
    `,
    ).run();
    const portfolio: PortfolioSummary = {
      totalValue: 1,
      totalPnl: 0,
      totalPnlPct: 0,
      dayChange: null,
      dayChangePct: null,
      source: 'manual',
      positions: [
        {
          symbol: 'ADDBLK',
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
    expect(r.insertedPortfolioAdd).toBe(0);
    expect(r.crossStrategyBlocked).toBe(1);
    expect(getOpenPaperTrades(db)).toHaveLength(1);
    expect(mockInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'ADDBLK',
        signalType: 'PORTFOLIO_ADD',
        blockReason: 'open_in_other_strategy',
      }),
      'paper trade dedup — symbol already open under different signal',
    );
  });

  it('accumulates crossStrategyBlocked across branches in one run', () => {
    portfolioAddPaperTrades.value = '1';
    db.prepare(
      `
      INSERT INTO paper_trades (
        symbol, signal_type, source_date, entry_price, stop_loss, target,
        time_horizon, max_hold_days, status
      ) VALUES ('RELIANCE', 'momentum_mf', '2026-04-01', 100, 92, 115, 'medium', 90, 'OPEN')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO paper_trades (
        symbol, signal_type, source_date, entry_price, stop_loss, target,
        time_horizon, max_hold_days, status
      ) VALUES ('INFY', 'AI_PICK', '2026-04-01', 100, 95, 120, 'medium', 90, 'OPEN')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO paper_trades (
        symbol, signal_type, source_date, entry_price, stop_loss, target,
        time_horizon, max_hold_days, status
      ) VALUES ('TCS', 'PORTFOLIO_ADD', '2026-04-01', 100, 95, 120, 'medium', 90, 'OPEN')
    `,
    ).run();
    seedCatalystScreen('RELIANCE', '2026-05-01');
    seedPathAScreen('INFY', '2026-05-01');

    const portfolio: PortfolioSummary = {
      totalValue: 1,
      totalPnl: 0,
      totalPnlPct: 0,
      dayChange: null,
      dayChangePct: null,
      source: 'manual',
      positions: [
        {
          symbol: 'TCS',
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

    const r = recordPaperTrades(
      '2026-05-01',
      [catalystThesisCard('RELIANCE'), aiPickThesisCard('INFY')],
      portfolio,
      db,
    );
    expect(r.crossStrategyBlocked).toBe(3);
    expect(r.insertedCatalystEntry).toBe(0);
    expect(r.insertedAiPick).toBe(0);
    expect(r.insertedPortfolioAdd).toBe(0);
    expect(getOpenPaperTrades(db)).toHaveLength(3);
  });

  it('allows AI_PICK when prior paper trade is CLOSED', () => {
    seedPathAScreen('RELIANCE', '2026-05-01');
    db.prepare(
      `
      INSERT INTO paper_trades (
        symbol, signal_type, source_date, entry_price, stop_loss, target,
        time_horizon, max_hold_days, status, outcome_date, exit_price, pnl_pct
      ) VALUES ('RELIANCE', 'momentum_mf', '2026-04-01', 100, 92, 115, 'medium', 90, 'CLOSED_WIN', '2026-04-20', 110, 10)
    `,
    ).run();
    const r = recordPaperTrades('2026-05-01', [aiPickThesisCard('RELIANCE')], undefined, db);
    expect(r.insertedAiPick).toBe(1);
    expect(r.crossStrategyBlocked).toBe(0);
    expect(getOpenPaperTrades(db)).toHaveLength(1);
    expect(getOpenPaperTrades(db)[0]?.signalType).toBe('AI_PICK');
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

  it('allows AI_PICK same-day reentry when a CLOSED trade exited on the same date', () => {
    seedPathAScreen('ADANIENSOL', '2026-07-06');
    // Prior AI_PICK that hit target on 2026-07-06; per guardrails.md line 48,
    // closed trades do not block entry (no same-day cooldown for CLOSED status).
    db.prepare(
      `
      INSERT INTO paper_trades (
        symbol, signal_type, source_date, entry_price, stop_loss, target,
        time_horizon, max_hold_days, status, outcome_date, exit_price, pnl_pct
      ) VALUES ('ADANIENSOL', 'AI_PICK', '2026-07-03', 100, 92, 115, 'medium', 90, 'CLOSED_WIN', '2026-07-06', 115, 15)
    `,
    ).run();

    const r = recordPaperTrades(
      '2026-07-06',
      [
        {
          symbol: 'ADANIENSOL',
          thesis: 'x',
          bullCase: ['a'],
          bearCase: ['b'],
          entryZone: '₹105',
          stopLoss: '₹98',
          target: '₹125',
          timeHorizon: 'short',
          confidence: 7,
          triggerReason: 'momentum',
        },
      ],
      undefined,
      db,
    );

    // CLOSED trades do not block per guardrails; only OPEN trades do
    expect(r.insertedAiPick).toBe(1);
    const openTrades = getOpenPaperTrades(db);
    expect(openTrades).toHaveLength(1);
    expect(openTrades[0]?.symbol).toBe('ADANIENSOL');
  });

  it('allows AI_PICK when prior paper trade closed on a different date', () => {
    seedPathAScreen('DIFFDATE', '2026-05-01');
    db.prepare(
      `
      INSERT INTO paper_trades (
        symbol, signal_type, source_date, entry_price, stop_loss, target,
        time_horizon, max_hold_days, status, outcome_date, exit_price, pnl_pct
      ) VALUES ('DIFFDATE', 'AI_PICK', '2026-04-01', 100, 92, 115, 'medium', 90, 'CLOSED_WIN', '2026-04-15', 115, 15)
    `,
    ).run();

    const r = recordPaperTrades(
      '2026-05-01',
      [
        {
          symbol: 'DIFFDATE',
          thesis: 'x',
          bullCase: ['a'],
          bearCase: ['b'],
          entryZone: '₹105',
          stopLoss: '₹98',
          target: '₹125',
          timeHorizon: 'short',
          confidence: 7,
          triggerReason: 'momentum',
        },
      ],
      undefined,
      db,
    );

    expect(r.insertedAiPick).toBe(1);
    expect(getOpenPaperTrades(db)).toHaveLength(1);
  });

  it('allows PORTFOLIO_ADD even when a CLOSED trade exited on the same date', () => {
    portfolioAddPaperTrades.value = '1';
    // ADANIENSOL closed on 2026-07-06; per guardrails.md, closed trades do not block
    db.prepare(
      `
      INSERT INTO paper_trades (
        symbol, signal_type, source_date, entry_price, stop_loss, target,
        time_horizon, max_hold_days, status, outcome_date, exit_price, pnl_pct
      ) VALUES ('ADANIENSOL', 'AI_PICK', '2026-07-03', 100, 92, 115, 'medium', 90, 'CLOSED_WIN', '2026-07-06', 115, 15)
    `,
    ).run();

    const portfolio: PortfolioSummary = {
      totalValue: 1,
      totalPnl: 0,
      totalPnlPct: 0,
      dayChange: null,
      dayChangePct: null,
      source: 'manual',
      positions: [
        {
          symbol: 'ADANIENSOL',
          qty: 10,
          avgPrice: 100,
          lastPrice: 105,
          pnl: 50,
          pnlPct: 5,
          dayChangePct: null,
          action: 'ADD',
          conviction: 0.7,
          thesis: null,
          triggerReason: null,
          bullPoints: [],
          bearPoints: [],
          suggestedStop: 98,
          suggestedTarget: 120,
        },
      ],
    };

    const r = recordPaperTrades('2026-07-06', [], portfolio, db);
    // CLOSED trades do not block per guardrails; only OPEN trades do
    expect(r.insertedPortfolioAdd).toBe(1);
    expect(getOpenPaperTrades(db)).toHaveLength(1);
  });
});
