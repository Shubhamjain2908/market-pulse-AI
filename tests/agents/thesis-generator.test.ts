import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildStockContext,
  generateTheses,
  getThesisRankMeta,
} from '../../src/agents/thesis-generator.js';
import {
  closeDb,
  getDb,
  getThesesForDate,
  migrate,
  upsertHoldings,
  upsertQuotes,
  upsertSignals,
} from '../../src/db/index.js';
import { parseAndValidate } from '../../src/llm/json.js';
import { MockLlmProvider } from '../../src/llm/providers/mock.js';
import type { LlmJsonResult, LlmProvider } from '../../src/llm/types.js';
import { type RawQuote, type Signal, ThesisSchema } from '../../src/types/domain.js';

describe('thesis generator', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;
  let llm: MockLlmProvider;
  const today = '2026-04-30';

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-thesis-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = dbPath;
    db = getDb({ path: dbPath });
    migrate(db);
    llm = new MockLlmProvider();
    seedTestData();
  });

  afterEach(() => {
    db.close();
    closeDb();
    try {
      rmSync(dbPath);
      rmSync(`${dbPath}-wal`);
      rmSync(`${dbPath}-shm`);
    } catch {
      /* best effort */
    }
  });

  function seedTestData(): void {
    const quote: RawQuote = {
      symbol: 'RELIANCE',
      exchange: 'NSE',
      date: today,
      open: 2900,
      high: 2950,
      low: 2880,
      close: 2940,
      volume: 2_000_000,
      source: 'test',
    };
    upsertQuotes([quote], db);

    const signals: Signal[] = [
      { symbol: 'RELIANCE', date: today, name: 'rsi_14', value: 75, source: 'technical' },
      {
        symbol: 'RELIANCE',
        date: today,
        name: 'volume_ratio_20d',
        value: 2.5,
        source: 'technical',
      },
      {
        symbol: 'RELIANCE',
        date: today,
        name: 'pct_from_52w_high',
        value: -1.5,
        source: 'technical',
      },
    ];
    upsertSignals(signals, db);
  }

  it('exposes thesis rank meta for briefing labels', () => {
    const meta = getThesisRankMeta(today, ['RELIANCE'], db);
    expect(meta.get('RELIANCE')?.rank).toBe(1);
    expect(meta.get('RELIANCE')?.reasonsLine).toContain('RSI');
  });

  it('generates a thesis for a stock with interesting signals', async () => {
    const result = await generateTheses(
      { date: today, watchlist: ['RELIANCE'], maxTheses: 1 },
      db,
      llm,
    );

    expect(result.generated).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.eligibleUniverseSize).toBe(1);
    expect(result.watchlistSize).toBe(1);
    expect(result.theses).toHaveLength(1);
    expect(result.theses[0]?.symbol).toBe('RELIANCE');
    expect(result.theses[0]?.thesis).toBeTruthy();

    const stored = getThesesForDate(today, db);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.model).toBe('mock-model');
  });

  it('does not generate AI picks for symbols already in the portfolio', async () => {
    upsertHoldings(
      [
        {
          symbol: 'RELIANCE',
          exchange: 'NSE',
          asOf: today,
          qty: 10,
          avgPrice: 2900,
          lastPrice: 2940,
          pnl: 400,
          pnlPct: 1.5,
          dayChange: 0,
          dayChangePct: 0,
          product: 'CNC',
          source: 'kite',
        },
      ],
      db,
    );
    const result = await generateTheses(
      { date: today, watchlist: ['RELIANCE'], maxTheses: 3 },
      db,
      llm,
    );
    expect(result.generated).toBe(0);
    expect(result.eligibleUniverseSize).toBe(0);
    expect(result.watchlistSize).toBe(1);
    expect(llm.calls).toHaveLength(0);
  });

  it('skips stocks with no interesting signals', async () => {
    const boringSignals: Signal[] = [
      { symbol: 'BORING', date: today, name: 'rsi_14', value: 50, source: 'technical' },
      {
        symbol: 'BORING',
        date: today,
        name: 'volume_ratio_20d',
        value: 1.0,
        source: 'technical',
      },
    ];
    upsertSignals(boringSignals, db);

    const result = await generateTheses(
      { date: today, watchlist: ['BORING'], maxTheses: 5 },
      db,
      llm,
    );

    expect(result.generated).toBe(0);
    expect(llm.calls).toHaveLength(0);
  });

  it('ranks candidates by interest score', async () => {
    const hot: Signal[] = [
      { symbol: 'HOTSTOCK', date: today, name: 'rsi_14', value: 25, source: 'technical' },
      {
        symbol: 'HOTSTOCK',
        date: today,
        name: 'volume_ratio_20d',
        value: 3.0,
        source: 'technical',
      },
      {
        symbol: 'HOTSTOCK',
        date: today,
        name: 'pct_from_52w_low',
        value: 3,
        source: 'technical',
      },
    ];
    upsertSignals(hot, db);

    db.prepare(
      `
      INSERT INTO screens (symbol, date, screen_name, score, matched_criteria)
      VALUES ('HOTSTOCK', ?, 'momentum_screen', 1, '{}')
    `,
    ).run(today);

    const result = await generateTheses(
      { date: today, watchlist: ['RELIANCE', 'HOTSTOCK'], maxTheses: 1 },
      db,
      llm,
    );

    expect(result.generated).toBe(1);
    expect(result.theses[0]?.symbol).toBe('HOTSTOCK');
  });

  it('appends momentum snapshot to stock context when momentum gate signals exist', () => {
    upsertSignals(
      [
        {
          symbol: 'RELIANCE',
          date: today,
          name: 'mom_rank',
          value: 5,
          source: 'momentum',
        },
      ],
      db,
    );
    const ctx = buildStockContext('RELIANCE', today, db, 'thesis');
    expect(ctx).toContain('## Momentum factor snapshot');
    expect(ctx).toContain('Composite rank');
  });

  it('adds momentum thesis addendum to the LLM system prompt when momentum context exists', async () => {
    upsertSignals(
      [
        {
          symbol: 'RELIANCE',
          date: today,
          name: 'mom_rank',
          value: 3,
          source: 'momentum',
        },
      ],
      db,
    );
    await generateTheses({ date: today, watchlist: ['RELIANCE'], maxTheses: 1 }, db, llm);
    const thesisCalls = llm.calls.filter((c) => c.method === 'generateJson');
    expect(thesisCalls.length).toBeGreaterThan(0);
    expect(thesisCalls[0]?.system).toContain('MOMENTUM CONTEXT');
  });

  it('keeps momentum snapshot when technical rows exist only on a newer session date', () => {
    upsertSignals(
      [{ symbol: 'RELIANCE', date: '2026-04-24', name: 'mom_rank', value: 12, source: 'momentum' }],
      db,
    );
    const ctx = buildStockContext('RELIANCE', today, db, 'thesis');
    expect(ctx).toContain('## Momentum factor snapshot');
    expect(ctx).toContain('Composite rank');
    expect(ctx).toMatch(/Technical Signals[\s\S]*rsi_14/s);
  });

  it('clamps confidenceScore to 5 when latest mom_false_flag is 1 even if LLM returns higher', async () => {
    upsertSignals(
      [
        {
          symbol: 'RELIANCE',
          date: '2026-04-24',
          name: 'mom_rank',
          value: 3,
          source: 'momentum',
        },
        {
          symbol: 'RELIANCE',
          date: '2026-04-24',
          name: 'mom_false_flag',
          value: 1,
          source: 'momentum',
        },
      ],
      db,
    );
    const hiConfLlm: LlmProvider = {
      name: 'stub',
      model: 'stub',
      async generateText(): Promise<never> {
        throw new Error('unused');
      },
      async generateJson<T>(): Promise<LlmJsonResult<T>> {
        const raw = JSON.stringify({
          symbol: 'RELIANCE',
          thesis: 'This thesis line is deliberately long enough for schema validation.',
          bullCase: ['Bull'],
          bearCase: ['Bear'],
          entryZone: '₹2,900',
          stopLoss: '₹2,800',
          target: '₹3,100',
          timeHorizon: 'medium',
          confidenceScore: 8,
          triggerScreen: 'test',
        });
        const data = parseAndValidate(raw, ThesisSchema) as T;
        return { data, raw, model: 'stub', usage: { durationMs: 1 } };
      },
    };
    await generateTheses({ date: today, watchlist: ['RELIANCE'], maxTheses: 1 }, db, hiConfLlm);
    const stored = getThesesForDate(today, db);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.confidence).toBe(5);
  });
});
