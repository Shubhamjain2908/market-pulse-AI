import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type PortfolioAction,
  analysePortfolio,
  applyPortfolioAddGuardrails,
} from '../../src/agents/portfolio-analyser.js';
import {
  closeDb,
  getDb,
  getPortfolioAnalysisForDate,
  migrate,
  upsertHoldings,
  upsertQuotes,
  upsertSignals,
} from '../../src/db/index.js';
import { MockLlmProvider } from '../../src/llm/providers/mock.js';
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
    );
    expect(out.action).toBe('ADD');
  });
});
