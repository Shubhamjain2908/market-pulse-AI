import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  analysePortfolio,
  applyPortfolioAddGuardrails,
  type PortfolioAction,
  PortfolioActionSchema,
} from '../../src/agents/portfolio-analyser.js';
import {
  applyMomentumPortfolioGuardrails,
  applyStrategyPortfolioGuardrails,
  resetPortfolioGuardrailCachesForTests,
  resolveHoldingEntrySource,
} from '../../src/agents/portfolio-strategy-guardrails.js';
import {
  closeDb,
  getDb,
  getPortfolioAnalysisForDate,
  insertPaperTradeIfAbsent,
  migrate,
  upsertHoldings,
  upsertQuotes,
  upsertSignals,
} from '../../src/db/index.js';
import { parseAndValidate } from '../../src/llm/json.js';
import { MockLlmProvider } from '../../src/llm/providers/mock.js';
import type { LlmProvider } from '../../src/llm/types.js';
import type { RawQuote } from '../../src/types/domain.js';

describe('portfolio analyser', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;
  const date = '2026-04-30';

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-pa-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = dbPath;
    process.env.PORTFOLIO_ANALYSIS_DISABLE_LITE = '1';
    db = getDb({ path: dbPath });
    migrate(db);
    seed();
  });

  afterEach(() => {
    process.env.PORTFOLIO_ANALYSIS_DISABLE_LITE = undefined;
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

  function seed(): void {
    const quote: RawQuote = {
      symbol: 'INFY',
      exchange: 'NSE',
      date,
      open: 1500,
      high: 1640,
      low: 1490,
      close: 1620,
      adjClose: 1620,
      volume: 5_000_000,
      source: 'test',
    };
    upsertQuotes([quote], db);
    const padHoldings = ['TCS', 'RELIANCE', 'ITC', 'SBIN', 'LT', 'WIPRO', 'AXISBANK'].map(
      (symbol) => ({
        symbol,
        exchange: 'NSE' as const,
        asOf: date,
        qty: 10,
        avgPrice: 6100,
        lastPrice: 6100,
        pnl: 0,
        pnlPct: 0,
        dayChange: 0,
        dayChangePct: 0,
        product: 'CNC',
        source: 'kite' as const,
      }),
    );
    upsertHoldings(
      [
        {
          symbol: 'INFY',
          exchange: 'NSE',
          asOf: date,
          qty: 50,
          avgPrice: 1500,
          lastPrice: 1620,
          pnl: 6000,
          pnlPct: 8,
          dayChange: 200,
          dayChangePct: 0.5,
          product: 'CNC',
          source: 'kite',
        },
        {
          symbol: 'HDFCBANK',
          exchange: 'NSE',
          asOf: date,
          qty: 30,
          avgPrice: 1700,
          lastPrice: 1640,
          pnl: -1800,
          pnlPct: -3.5,
          dayChange: -90,
          dayChangePct: -0.5,
          product: 'CNC',
          source: 'kite',
        },
        ...padHoldings,
      ],
      db,
    );
  }

  it('produces one analysis row per holding using the mock LLM', async () => {
    const llm = new MockLlmProvider();
    const result = await analysePortfolio({ date }, db, llm);

    expect(result.analysed).toBe(9);
    expect(result.failed).toBe(0);
    expect(result.fullLlmCount).toBe(9);
    expect(result.liteCount).toBe(0);
    expect(result.byAction.HOLD).toBe(9);
    expect(llm.calls).toHaveLength(9);

    const persisted = getPortfolioAnalysisForDate(date, db);
    expect(persisted).toHaveLength(9);
    const symbols = persisted.map((p) => p.symbol).sort();
    expect(symbols).toContain('HDFCBANK');
    expect(symbols).toContain('INFY');

    const infy = persisted.find((p) => p.symbol === 'INFY');
    expect(infy?.action).toBe('HOLD');
    expect(infy?.bullPoints.length).toBeGreaterThan(0);
    expect(infy?.bearPoints.length).toBeGreaterThan(0);
    expect(infy?.pnlPct).toBe(8);
    expect(infy?.thesis.length).toBeGreaterThan(20);
  });

  it('respects symbols filter and minPositionInr', async () => {
    const llm = new MockLlmProvider();
    const result = await analysePortfolio({ date, symbols: ['INFY'] }, db, llm);
    expect(result.analysed).toBe(1);
    expect(result.rows[0]?.symbol).toBe('INFY');

    // INFY position = 50 * 1500 = 75,000; padding holdings = 61,000 each; HDFCBANK = 51,000.
    // minPositionInr=72_000 should keep only INFY.
    const llm2 = new MockLlmProvider();
    const filtered = await analysePortfolio({ date, minPositionInr: 72_000 }, db, llm2);
    expect(filtered.analysed).toBe(1);
    expect(filtered.rows[0]?.symbol).toBe('INFY');
  });

  it('downgrades ADD to HOLD when volume_ratio_20d is below 0.5', async () => {
    upsertSignals(
      [
        { symbol: 'INFY', date, name: 'rsi_14', value: 55, source: 'technical' },
        {
          symbol: 'INFY',
          date,
          name: 'volume_ratio_20d',
          value: 0.36,
          source: 'technical',
        },
      ],
      db,
    );
    const llm = new MockLlmProvider();
    const result = await analysePortfolio({ date, symbols: ['INFY'] }, db, llm);
    const infy = result.rows.find((r) => r.symbol === 'INFY');
    expect(infy?.action).toBe('HOLD');
    expect(infy?.triggerReason).toContain('volume_ratio');
  });

  it('downgrades ADD to HOLD when RSI is overbought (post-LLM guardrail)', async () => {
    upsertSignals([{ symbol: 'INFY', date, name: 'rsi_14', value: 72, source: 'technical' }], db);
    const llm = new MockLlmProvider();
    const result = await analysePortfolio({ date, symbols: ['INFY'] }, db, llm);
    const infy = result.rows.find((r) => r.symbol === 'INFY');
    expect(infy?.action).toBe('HOLD');
    expect(infy?.triggerReason).toContain('Guardrail');
  });

  it('returns empty result when there are no holdings', async () => {
    db.prepare('DELETE FROM portfolio_holdings').run();
    const llm = new MockLlmProvider();
    const result = await analysePortfolio({ date }, db, llm);
    expect(result.analysed).toBe(0);
    expect(result.byAction.HOLD).toBe(0);
    expect(llm.calls).toHaveLength(0);
  });

  it('skips LLM and writes stale placeholder rows when Kite as_of is before the expected session', async () => {
    const runDate = '2026-05-04';
    const staleAsOf = '2026-04-30';
    db.prepare('DELETE FROM portfolio_holdings').run();
    const quoteRun: RawQuote = {
      symbol: 'INFY',
      exchange: 'NSE',
      date: runDate,
      open: 1500,
      high: 1640,
      low: 1490,
      close: 1620,
      adjClose: 1620,
      volume: 5_000_000,
      source: 'test',
    };
    upsertQuotes([quoteRun], db);
    upsertHoldings(
      [
        {
          symbol: 'INFY',
          exchange: 'NSE',
          asOf: staleAsOf,
          qty: 50,
          avgPrice: 1500,
          lastPrice: 1620,
          pnl: 6000,
          pnlPct: 8,
          dayChange: 200,
          dayChangePct: 0.5,
          product: 'CNC',
          source: 'kite',
        },
        {
          symbol: 'HDFCBANK',
          exchange: 'NSE',
          asOf: staleAsOf,
          qty: 30,
          avgPrice: 1700,
          lastPrice: 1640,
          pnl: -1800,
          pnlPct: -3.5,
          dayChange: -90,
          dayChangePct: -0.5,
          product: 'CNC',
          source: 'kite',
        },
      ],
      db,
    );
    const llm = new MockLlmProvider();
    const result = await analysePortfolio({ date: runDate }, db, llm);
    expect(llm.calls).toHaveLength(0);
    expect(result.fullLlmCount).toBe(0);
    expect(result.liteCount).toBe(0);
    expect(result.analysed).toBe(2);
    expect(result.byAction.HOLD).toBe(2);
    const infy = result.rows.find((r) => r.symbol === 'INFY');
    expect(infy?.model).toBe('none');
    expect(infy?.conviction).toBe(0);
    expect(infy?.thesis).toBe('Skipped: stale portfolio holdings');
    expect(infy?.triggerReason).toContain('STALE_HOLDINGS');
    expect(infy?.triggerReason).toContain(staleAsOf);
    expect(infy?.bullPoints).toEqual([]);
    expect(infy?.bearPoints).toEqual([]);

    const persisted = getPortfolioAnalysisForDate(runDate, db);
    expect(persisted).toHaveLength(2);
  });

  it('does not apply stale guard when all holdings are manual', async () => {
    const runDate = '2026-05-04';
    db.prepare('DELETE FROM portfolio_holdings').run();
    upsertHoldings(
      [
        {
          symbol: 'INFY',
          exchange: 'NSE',
          asOf: '2026-04-30',
          qty: 50,
          avgPrice: 1500,
          lastPrice: 1620,
          pnl: 6000,
          pnlPct: 8,
          dayChange: 200,
          dayChangePct: 0.5,
          product: 'CNC',
          source: 'manual',
        },
      ],
      db,
    );
    const llm = new MockLlmProvider();
    await analysePortfolio({ date: runDate, symbols: ['INFY'] }, db, llm);
    expect(llm.calls.length).toBeGreaterThan(0);
  });

  const baseAction = (): PortfolioAction => ({
    symbol: 'ITC',
    action: 'ADD',
    conviction: 0.65,
    thesis: 'Holding for recovery as valuations normalize relative to peers over time.',
    bullPoints: ['Valuation'],
    bearPoints: ['Weak tape'],
    triggerReason: 'Adding into weakness per setup.',
    suggestedStop: 298,
    suggestedTarget: null,
  });

  it('downgrades ADD to HOLD when averaging-down R:R vs stop is poor', () => {
    const out = applyPortfolioAddGuardrails(
      baseAction(),
      { rsi_14: 55, pct_from_52w_high: -15 },
      {
        pnlPct: -18.5,
        lastPrice: 315,
      },
      null,
    );
    expect(out.action).toBe('HOLD');
    expect(out.triggerReason).toContain('averaging down');
    expect(out.triggerReason).toContain('Guardrail');
  });

  it('preserves ADD on a shallow loss with a wide enough stop', () => {
    const out = applyPortfolioAddGuardrails(
      { ...baseAction(), action: 'ADD', suggestedStop: 280, triggerReason: 'Dip buy.' },
      { rsi_14: 50, pct_from_52w_high: -20 },
      { pnlPct: -3.5, lastPrice: 315 },
      null,
    );
    expect(out.action).toBe('ADD');
  });

  it('preserves ADD on a winning position even with a tight stop', () => {
    const out = applyPortfolioAddGuardrails(
      baseAction(),
      { rsi_14: 45, pct_from_52w_high: -30 },
      {
        pnlPct: 5,
        lastPrice: 315,
      },
      null,
    );
    expect(out.action).toBe('ADD');
  });

  it('blocks ADD when the symbol already has open paper trades', async () => {
    insertPaperTradeIfAbsent(
      {
        symbol: 'INFY',
        signalType: 'PORTFOLIO_ADD',
        sourceDate: '2026-04-29',
        entryPrice: 1590,
        stopLoss: 1500,
        target: 1750,
        timeHorizon: 'medium',
        maxHoldDays: 90,
      },
      db,
    );

    const addLlm = {
      name: 'test-add',
      model: 'test-add',
      async generateText() {
        return { text: 'unused', model: 'test-add', usage: { durationMs: 1 } };
      },
      async generateJson() {
        return {
          data: {
            symbol: 'INFY',
            action: 'ADD',
            conviction: 0.84,
            thesis: 'Momentum and setup still support accumulation in this swing timeframe.',
            bullPoints: ['Setup intact'],
            bearPoints: ['Event risk'],
            triggerReason: 'Adding to position after confirmation.',
            suggestedStop: 1540,
            suggestedTarget: 1760,
          },
          raw: '{}',
          model: 'test-add',
          usage: { durationMs: 1 },
        };
      },
    };

    const result = await analysePortfolio(
      { date, symbols: ['INFY'] },
      db,
      addLlm as unknown as LlmProvider,
    );
    const row = result.rows.find((r) => r.symbol === 'INFY');
    expect(row?.action).toBe('HOLD');
    expect(row?.triggerReason).toContain('ADD blocked');
    expect(row?.triggerReason).toContain('1 open trades for INFY');
  });

  it('shadows ADD in Stage 4 with annotation but does not change action', async () => {
    upsertSignals(
      [
        {
          symbol: 'INFY',
          date: '2026-04-29',
          name: 'weinstein_stage_code',
          value: 4,
          source: 'technical',
        },
      ],
      db,
    );

    const addLlm = {
      name: 'test-add',
      model: 'test-add',
      async generateText() {
        return { text: 'unused', model: 'test-add', usage: { durationMs: 1 } };
      },
      async generateJson() {
        return {
          data: {
            symbol: 'INFY',
            action: 'ADD',
            conviction: 0.7,
            thesis: 'Infosys at support with strong tech stack for a sustained recovery period.',
            bullPoints: ['Value'],
            bearPoints: ['FX headwind'],
            triggerReason: 'Adding on dip after strong results.',
            suggestedStop: 1500,
            suggestedTarget: 1750,
          },
          raw: '{}',
          model: 'test-add',
          usage: { durationMs: 1 },
        };
      },
    };

    const result = await analysePortfolio(
      { date, symbols: ['INFY'] },
      db,
      addLlm as unknown as LlmProvider,
    );
    const row = result.rows.find((r) => r.symbol === 'INFY');
    // Action unchanged — shadow only
    expect(row?.action).toBe('ADD');
    // Annotation present
    expect(row?.triggerReason).toContain('[shadow: ADD recommended in Weinstein Stage 4]');
  });

  it('does not shadow ADD when stage_code is 22 (Stage 2B)', async () => {
    upsertSignals(
      [
        {
          symbol: 'INFY',
          date: '2026-04-29',
          name: 'weinstein_stage_code',
          value: 22,
          source: 'technical',
        },
      ],
      db,
    );

    const addLlm = {
      name: 'test-add',
      model: 'test-add',
      async generateText() {
        return { text: 'unused', model: 'test-add', usage: { durationMs: 1 } };
      },
      async generateJson() {
        return {
          data: {
            symbol: 'INFY',
            action: 'ADD',
            conviction: 0.7,
            thesis: 'Infosys at support with strong tech stack for a sustained recovery period.',
            bullPoints: ['Value'],
            bearPoints: ['FX headwind'],
            triggerReason: 'Adding on dip after strong results.',
            suggestedStop: 1500,
            suggestedTarget: 1750,
          },
          raw: '{}',
          model: 'test-add',
          usage: { durationMs: 1 },
        };
      },
    };

    const result = await analysePortfolio(
      { date, symbols: ['INFY'] },
      db,
      addLlm as unknown as LlmProvider,
    );
    const row = result.rows.find((r) => r.symbol === 'INFY');
    // Action still ADD
    expect(row?.action).toBe('ADD');
    // No Stage 4 annotation
    expect(row?.triggerReason).not.toContain('Stage 4');
  });

  it('does not apply RSI ADD guardrail for excluded ETF/SGB symbols', () => {
    const out = applyPortfolioAddGuardrails(
      { ...baseAction(), symbol: 'GOLDBEES', triggerReason: 'ETF add test.' },
      { rsi_14: 88, pct_from_52w_high: -12, volume_ratio_20d: 2.2 },
      {
        pnlPct: 3,
        lastPrice: 315,
      },
      null,
    );
    expect(out.action).toBe('ADD');
  });

  it('skips equity LLM for allocation instruments in etf-exclusions', async () => {
    upsertQuotes(
      [
        {
          symbol: 'GOLDBEES',
          exchange: 'NSE',
          date,
          open: 60,
          high: 61,
          low: 59,
          close: 60.5,
          adjClose: 60.5,
          volume: 1_000_000,
          source: 'test',
        },
      ],
      db,
    );
    upsertHoldings(
      [
        {
          symbol: 'GOLDBEES',
          exchange: 'NSE',
          asOf: date,
          qty: 100,
          avgPrice: 58,
          lastPrice: 60.5,
          pnl: 250,
          pnlPct: 4.3,
          dayChange: 20,
          dayChangePct: 0.3,
          product: 'CNC',
          source: 'kite',
        },
      ],
      db,
    );

    const throwingLlm = {
      name: 'throw',
      model: 'throw',
      async generateText() {
        throw new Error('LLM should not run for allocation instruments');
      },
      async generateJson() {
        throw new Error('LLM should not run for allocation instruments');
      },
    };

    const result = await analysePortfolio(
      { date, symbols: ['GOLDBEES'] },
      db,
      throwingLlm as unknown as LlmProvider,
    );
    const row = result.rows.find((r) => r.symbol === 'GOLDBEES');
    expect(row?.model).toBe('none');
    expect(row?.action).toBe('HOLD');
    expect(row?.triggerReason).toContain('ALLOCATION_INSTRUMENT');
    expect(row?.thesis).toContain('Allocation sleeve');
  });

  it('includes soft concentration flag in LLM position context at 14% weight', async () => {
    db.prepare('DELETE FROM portfolio_holdings').run();
    upsertHoldings(
      [
        {
          symbol: 'PAYTM',
          exchange: 'NSE',
          asOf: date,
          qty: 14,
          avgPrice: 1000,
          lastPrice: 1000,
          pnl: 0,
          pnlPct: 0,
          dayChange: 0,
          dayChangePct: 0,
          product: 'CNC',
          source: 'kite',
        },
        {
          symbol: 'TCS',
          exchange: 'NSE',
          asOf: date,
          qty: 86,
          avgPrice: 1000,
          lastPrice: 1000,
          pnl: 0,
          pnlPct: 0,
          dayChange: 0,
          dayChangePct: 0,
          product: 'CNC',
          source: 'kite',
        },
      ],
      db,
    );

    let capturedUser = '';
    const captureLlm = {
      name: 'capture',
      model: 'capture',
      async generateText() {
        return { text: 'unused', model: 'capture', usage: { durationMs: 1 } };
      },
      async generateJson(opts: { user: string }) {
        capturedUser = opts.user;
        return {
          data: {
            symbol: 'PAYTM',
            action: 'HOLD',
            conviction: 0.5,
            thesis: 'Hold line with enough length for schema validation in this portfolio test.',
            bullPoints: ['Stable'],
            bearPoints: ['Macro'],
            triggerReason: 'No change.',
            suggestedStop: null,
            suggestedTarget: null,
          },
          raw: '{}',
          model: 'capture',
          usage: { durationMs: 1 },
        };
      },
    };

    await analysePortfolio({ date, symbols: ['PAYTM'] }, db, captureLlm as unknown as LlmProvider);
    expect(capturedUser).toContain('CONCENTRATION');
    expect(capturedUser).toContain('Soft limit 10%');
  });

  it('hard TRIMs concentrated equity when LIQUIDCASE is excluded from denominator', async () => {
    db.prepare('DELETE FROM portfolio_holdings').run();
    upsertHoldings(
      [
        {
          symbol: 'LIQUIDCASE',
          exchange: 'NSE',
          asOf: date,
          qty: 500,
          avgPrice: 100,
          lastPrice: 100,
          pnl: 0,
          pnlPct: 0,
          dayChange: 0,
          dayChangePct: 0,
          product: 'CNC',
          source: 'kite',
        },
        {
          symbol: 'PAYTM',
          exchange: 'NSE',
          asOf: date,
          qty: 12,
          avgPrice: 1000,
          lastPrice: 1000,
          pnl: 0,
          pnlPct: 0,
          dayChange: 0,
          dayChangePct: 0,
          product: 'CNC',
          source: 'kite',
        },
        {
          symbol: 'TCS',
          exchange: 'NSE',
          asOf: date,
          qty: 38,
          avgPrice: 1000,
          lastPrice: 1000,
          pnl: 0,
          pnlPct: 0,
          dayChange: 0,
          dayChangePct: 0,
          product: 'CNC',
          source: 'kite',
        },
      ],
      db,
    );

    const llm = new MockLlmProvider();
    const result = await analysePortfolio({ date, symbols: ['PAYTM'] }, db, llm);
    const paytm = result.rows.find((r) => r.symbol === 'PAYTM');
    expect(paytm?.action).toBe('TRIM');
    expect(paytm?.triggerReason).toContain('concentration');
  });

  it('appends regime context to portfolio LLM prompt when regime_daily exists', async () => {
    db.prepare(
      `INSERT INTO regime_daily (
        date, regime, score_total, score_trend, score_vix, score_fii, score_breadth,
        vix_value, nifty_vs_sma200, fii_20d_net, crisis_override, regime_age
      ) VALUES (?, 'BEAR_TRENDING', -5, -2, -1, -1, -1, 22, -4, -5000, 0, 2)`,
    ).run(date);

    let capturedUser = '';
    let capturedSystem = '';
    const captureLlm = {
      name: 'capture',
      model: 'capture',
      async generateText() {
        return { text: 'unused', model: 'capture', usage: { durationMs: 1 } };
      },
      async generateJson(opts: { user: string; system: string }) {
        capturedUser = opts.user;
        capturedSystem = opts.system;
        return {
          data: {
            symbol: 'INFY',
            action: 'HOLD',
            conviction: 0.5,
            thesis: 'Hold line with enough length for schema validation in this portfolio test.',
            bullPoints: ['Stable'],
            bearPoints: ['Macro'],
            triggerReason: 'No change.',
            suggestedStop: null,
            suggestedTarget: null,
          },
          raw: '{}',
          model: 'capture',
          usage: { durationMs: 1 },
        };
      },
    };

    await analysePortfolio({ date, symbols: ['INFY'] }, db, captureLlm as unknown as LlmProvider);
    expect(capturedUser).toContain('REGIME: BEAR_TRENDING');
    expect(capturedSystem).toContain('ACTIVE REGIME: BEAR_TRENDING');
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

  describe('applyStrategyPortfolioGuardrails', () => {
    beforeEach(() => {
      resetPortfolioGuardrailCachesForTests();
    });

    const strategyHold = (symbol = 'ITC'): PortfolioAction => ({
      symbol,
      action: 'HOLD',
      conviction: 0.55,
      thesis: 'Hold line.',
      bullPoints: ['Trend'],
      bearPoints: ['Macro'],
      triggerReason: 'No change.',
      suggestedStop: null,
      suggestedTarget: null,
    });

    it('forces EXIT on severe quality_garp deterioration', () => {
      for (const asOf of ['2024-03-31', '2023-03-31', '2022-03-31']) {
        db.prepare(
          `INSERT INTO fundamentals (symbol, as_of, source, roe, roce, peg, debt_to_equity)
           VALUES ('QG', ?, 'yahoo_annual', 0.2, 0.25, 1, 0.2)`,
        ).run(asOf);
      }
      db.prepare(
        `INSERT INTO fundamentals (symbol, as_of, source, pe, pb, peg, debt_to_equity, profit_growth_yoy)
         VALUES ('QG', '2026-06-25', 'yahoo_snapshot', 20, 3, 1, 0.2, -4)`,
      ).run();
      db.prepare(
        `INSERT INTO fundamentals (symbol, as_of, source, promoter_holding_pct, promoter_holding_change_qoq)
         VALUES ('QG', '2026-06-24', 'screener', 50, -2)`,
      ).run();
      const out = applyStrategyPortfolioGuardrails(
        strategyHold('QG'),
        {},
        { entrySource: 'quality_garp', symbol: 'QG', date: '2026-06-25', db, pnlPct: 5 },
      );
      expect(out.action).toBe('EXIT');
      expect(out.triggerReason).toContain('GUARDRAIL_OVERRIDE');
    });

    it('leaves quality_garp unchanged on a single deterioration flag', () => {
      for (const asOf of ['2024-03-31', '2023-03-31', '2022-03-31']) {
        db.prepare(
          `INSERT INTO fundamentals (symbol, as_of, source, roe, roce, peg, debt_to_equity)
           VALUES ('QG1', ?, 'yahoo_annual', 0.2, 0.25, 1, 0.2)`,
        ).run(asOf);
      }
      db.prepare(
        `INSERT INTO fundamentals (symbol, as_of, source, pe, pb, peg, debt_to_equity)
         VALUES ('QG1', '2026-06-25', 'yahoo_snapshot', 20, 3, 1.5, 0.2)`,
      ).run();
      const out = applyStrategyPortfolioGuardrails(
        strategyHold('QG1'),
        {},
        { entrySource: 'quality_garp', symbol: 'QG1', date: '2026-06-25', db, pnlPct: 5 },
      );
      expect(out.action).toBe('HOLD');
      expect(out.triggerReason).toBe('No change.');
    });

    it('applies quality_garp guardrails with fundamentals before analysis date', () => {
      for (const asOf of ['2024-03-31', '2023-03-31', '2022-03-31']) {
        db.prepare(
          `INSERT INTO fundamentals (symbol, as_of, source, roe, roce, peg, debt_to_equity)
           VALUES ('QGPIT', ?, 'yahoo_annual', 0.2, 0.25, 1, 0.2)`,
        ).run(asOf);
      }
      db.prepare(
        `INSERT INTO fundamentals (symbol, as_of, source, pe, pb, peg, debt_to_equity, profit_growth_yoy)
         VALUES ('QGPIT', '2026-06-20', 'yahoo_snapshot', 20, 3, 1, 0.2, -4)`,
      ).run();
      db.prepare(
        `INSERT INTO fundamentals (symbol, as_of, source, promoter_holding_pct, promoter_holding_change_qoq)
         VALUES ('QGPIT', '2026-06-19', 'screener', 50, -2)`,
      ).run();
      const out = applyStrategyPortfolioGuardrails(
        strategyHold('QGPIT'),
        {},
        { entrySource: 'quality_garp', symbol: 'QGPIT', date: '2026-06-25', db, pnlPct: 5 },
      );
      expect(out.action).toBe('EXIT');
      expect(out.triggerReason).toContain('GUARDRAIL_OVERRIDE');
    });

    it('trims unknown origin on QG deterioration but never EXIT at 4 flags', () => {
      for (const asOf of ['2024-03-31', '2023-03-31', '2022-03-31']) {
        db.prepare(
          `INSERT INTO fundamentals (symbol, as_of, source, roe, roce, peg, debt_to_equity)
           VALUES ('UNK', ?, 'yahoo_annual', 0.1, 0.1, 2, 1)`,
        ).run(asOf);
      }
      db.prepare(
        `INSERT INTO fundamentals (symbol, as_of, source, pe, pb, peg, debt_to_equity, profit_growth_yoy)
         VALUES ('UNK', '2026-06-25', 'yahoo_snapshot', 20, 3, 2, 1, -4)`,
      ).run();
      db.prepare(
        `INSERT INTO fundamentals (symbol, as_of, source, promoter_holding_pct, promoter_holding_change_qoq)
         VALUES ('UNK', '2026-06-24', 'screener', 50, -2)`,
      ).run();
      const out = applyStrategyPortfolioGuardrails(
        strategyHold('UNK'),
        {},
        { entrySource: 'unknown', symbol: 'UNK', date: '2026-06-25', db, pnlPct: 5 },
      );
      expect(out.action).toBe('TRIM');
      expect(out.triggerReason).toContain('universal_qg');
    });

    it('hard TRIMs when invested weight exceeds 15%', () => {
      const out = applyStrategyPortfolioGuardrails(
        strategyHold('BIG'),
        {},
        {
          entrySource: 'unknown',
          symbol: 'BIG',
          date: '2026-06-25',
          db,
          pnlPct: 20,
          weightPct: 16,
        },
      );
      expect(out.action).toBe('TRIM');
      expect(out.triggerReason).toContain('concentration');
    });

    it('technical trim escalation promotes HOLD to TRIM on extended winner', () => {
      const out = applyStrategyPortfolioGuardrails(
        strategyHold('WIN'),
        { rsi_14: 78, pct_from_52w_high: -2 },
        {
          entrySource: 'unknown',
          symbol: 'WIN',
          date: '2026-06-25',
          db,
          pnlPct: 60,
        },
      );
      expect(out.action).toBe('TRIM');
      expect(out.triggerReason).toContain('LITE_ESCALATION');
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
      const out = applyStrategyPortfolioGuardrails(
        strategyHold('CAT2'),
        {},
        { entrySource: 'catalyst_entry', symbol: 'CAT2', date: '2026-06-10', db, pnlPct: 2 },
      );
      expect(out.action).toBe('TRIM');
      expect(out.triggerReason).toContain('Catalyst');
    });

    it('trims inferred catalyst_entry after expected_earnings_date + 2', () => {
      db.prepare(
        `INSERT INTO screens (symbol, date, screen_name, score, matched_criteria)
         VALUES (
           'CEX',
           '2026-06-01',
           'catalyst_entry',
           7,
           '{"expected_earnings_date":"2026-06-10","days_to_earnings":9}'
         )`,
      ).run();
      const out = applyStrategyPortfolioGuardrails(
        strategyHold('CEX'),
        {},
        { entrySource: 'catalyst_entry', symbol: 'CEX', date: '2026-06-15', db, pnlPct: 2 },
      );
      expect(out.action).toBe('TRIM');
      expect(out.triggerReason).toContain('post-earnings window ended 2026-06-12');
    });
  });
});

describe('applyMomentumPortfolioGuardrails', () => {
  const baseHold = (): PortfolioAction => ({
    symbol: 'ITC',
    action: 'HOLD',
    conviction: 0.55,
    thesis: 'Hold line.',
    bullPoints: ['Trend'],
    bearPoints: ['Macro'],
    triggerReason: 'No change.',
    suggestedStop: null,
    suggestedTarget: null,
  });

  it('trims momentum_mf holdings on first mom_rank threshold breach', () => {
    const out = applyMomentumPortfolioGuardrails(
      baseHold(),
      { mom_rank: 21 },
      { entrySource: 'momentum_mf' },
    );
    expect(out.action).toBe('TRIM');
    expect(out.triggerReason).toContain('GUARDRAIL_OVERRIDE');
    expect(out.triggerReason).toContain('rank decay');
    expect(out.triggerReason).toContain('mom_rank');
  });

  it('forces EXIT for momentum_mf holdings on severe mom_rank decay', () => {
    const out = applyMomentumPortfolioGuardrails(
      baseHold(),
      { mom_rank: 26 },
      { entrySource: 'momentum_mf' },
    );
    expect(out.action).toBe('EXIT');
    expect(out.triggerReason).toContain('GUARDRAIL_OVERRIDE');
    expect(out.triggerReason).toContain('severe rank decay');
  });

  it('does not apply mom_rank exit logic to non-momentum holdings', () => {
    const out = applyMomentumPortfolioGuardrails(
      baseHold(),
      { mom_rank: 99 },
      { entrySource: 'quality_garp' },
    );
    expect(out.action).toBe('HOLD');
    expect(out.triggerReason).toBe('No change.');
  });

  it('does not mutate triggerReason when already EXIT', () => {
    const out = applyMomentumPortfolioGuardrails(
      { ...baseHold(), action: 'EXIT', triggerReason: 'Manual exit.' },
      { mom_rank: 99 },
      { entrySource: 'momentum_mf' },
    );
    expect(out.action).toBe('EXIT');
    expect(out.triggerReason).toBe('Manual exit.');
  });

  it('downgrades ADD to HOLD when mom_false_flag is 1', () => {
    const out = applyMomentumPortfolioGuardrails(
      {
        ...baseHold(),
        action: 'ADD',
        conviction: 0.7,
        triggerReason: 'Scale in.',
      },
      { mom_false_flag: 1 },
    );
    expect(out.action).toBe('HOLD');
    expect(out.triggerReason).toContain('mom_false_flag');
  });

  it('is a no-op when no momentum guardrail fields are present', () => {
    const a = baseHold();
    expect(applyMomentumPortfolioGuardrails(a, {})).toEqual(a);
  });
});

describe('PortfolioActionSchema (LLM output)', () => {
  it('truncates triggerReason longer than 280 chars so JSON parse does not fail', () => {
    const long = `Why now: ${'word '.repeat(60)}end`;
    expect(long.length).toBeGreaterThan(280);
    const raw = JSON.stringify({
      symbol: 'T',
      action: 'HOLD',
      conviction: 0.5,
      thesis: 'Thesis line with enough length for min twenty chars ok.',
      bullPoints: ['Bull one'],
      bearPoints: ['Bear one'],
      triggerReason: long,
    });
    const out = parseAndValidate(raw, PortfolioActionSchema);
    expect(out.triggerReason.length).toBeLessThanOrEqual(280);
    expect(out.triggerReason.endsWith('…')).toBe(true);
  });
});
