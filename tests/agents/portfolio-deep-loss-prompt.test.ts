import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analysePortfolio } from '../../src/agents/portfolio-analyser.js';
import { PORTFOLIO_DEEP_LOSS_PCT } from '../../src/agents/portfolio-trigger.js';
import { closeDb, getDb, migrate, upsertHoldings, upsertQuotes } from '../../src/db/index.js';
import { MockLlmProvider } from '../../src/llm/providers/mock.js';
import type { RawQuote } from '../../src/types/domain.js';

describe('portfolio deep-loss prompt', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;
  const date = '2026-04-30';

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-deep-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = dbPath;
    process.env.PORTFOLIO_ANALYSIS_DISABLE_LITE = '1';
    db = getDb({ path: dbPath });
    migrate(db);
    const quote: RawQuote = {
      symbol: 'LOSER',
      exchange: 'NSE',
      date,
      open: 100,
      high: 100,
      low: 40,
      close: 45,
      volume: 1,
      source: 'test',
    };
    upsertQuotes([quote], db);
    upsertHoldings(
      [
        {
          symbol: 'LOSER',
          exchange: 'NSE',
          asOf: date,
          qty: 100,
          avgPrice: 100,
          lastPrice: 45,
          pnl: -5500,
          pnlPct: PORTFOLIO_DEEP_LOSS_PCT,
          dayChange: 0,
          dayChangePct: 0,
          product: 'CNC',
          source: 'kite',
        },
      ],
      db,
    );
  });

  afterEach(() => {
    process.env.PORTFOLIO_ANALYSIS_DISABLE_LITE = undefined;
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

  it('adds deep-loss instructions to the portfolio LLM system prompt', async () => {
    const llm = new MockLlmProvider();
    await analysePortfolio({ date }, db, llm);
    const jsonCall = llm.calls.find((c) => c.method === 'generateJson');
    expect(jsonCall).toBeDefined();
    expect(jsonCall?.system).toContain('UNREALISED LOSS');
    expect(jsonCall?.system).toMatch(/30|%/);
  });
});
