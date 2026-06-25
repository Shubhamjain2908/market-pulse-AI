import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  analysePortfolio,
  applyMomentumPortfolioGuardrails,
  applyPortfolioAddGuardrails,
  type PortfolioAction,
  PortfolioActionSchema,
} from '../../src/agents/portfolio-analyser.js';
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
      ],
      db,
    );
  }

  it('produces one analysis row per holding using the mock LLM', async () => {
    const llm = new MockLlmProvider();
    const result = await analysePortfolio({ date }, db, llm);

    expect(result.analysed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.fullLlmCount).toBe(2);
    expect(result.liteCount).toBe(0);
    expect(result.byAction.HOLD).toBe(2);
    expect(llm.calls).toHaveLength(2);

    const persisted = getPortfolioAnalysisForDate(date, db);
    expect(persisted).toHaveLength(2);
    const symbols = persisted.map((p) => p.symbol).sort();
    expect(symbols).toEqual(['HDFCBANK', 'INFY']);

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

    // INFY position = 50 * 1500 = 75,000; HDFCBANK = 30*1700 = 51,000.
    // minPositionInr=60_000 should keep only INFY.
    const llm2 = new MockLlmProvider();
    const filtered = await analysePortfolio({ date, minPositionInr: 60_000 }, db, llm2);
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

  it('omits RSI and volume-ratio lines from LLM payload for excluded symbols', async () => {
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
    upsertSignals(
      [
        { symbol: 'GOLDBEES', date, name: 'rsi_14', value: 76, source: 'technical' },
        { symbol: 'GOLDBEES', date, name: 'volume_ratio_20d', value: 0.4, source: 'technical' },
      ],
      db,
    );
    db.prepare(
      `
      INSERT INTO alerts (symbol, date, signal, kind, value, message)
      VALUES ('GOLDBEES', ?, 'RSI 14', 'rsi_overbought', 76, 'RSI crossed 70')
    `,
    ).run(date);

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
            symbol: 'GOLDBEES',
            action: 'HOLD',
            conviction: 0.5,
            thesis: 'Excluded ETF symbol, so hold without RSI or volume-ratio interpretation.',
            bullPoints: ['Stable exposure'],
            bearPoints: ['Macro risk'],
            triggerReason: 'No add trigger.',
            suggestedStop: null,
            suggestedTarget: null,
          },
          raw: '{}',
          model: 'capture',
          usage: { durationMs: 1 },
        };
      },
    };

    await analysePortfolio(
      { date, symbols: ['GOLDBEES'] },
      db,
      captureLlm as unknown as LlmProvider,
    );
    expect(capturedUser).toContain('Current position value:');
    expect(capturedUser).toContain('Current portfolio weight:');
    expect(capturedUser).toContain('Entry source: unknown');
    expect(capturedUser).not.toContain('rsi_14:');
    expect(capturedUser).not.toContain('volume_ratio_20d:');
    expect(capturedUser).not.toContain('rsi_overbought');
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
