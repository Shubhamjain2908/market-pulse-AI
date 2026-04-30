import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeBriefing } from '../../src/briefing/composer.js';
import {
  closeDb,
  getDb,
  insertNews,
  migrate,
  upsertQuotes,
  upsertSignals,
  upsertThesis,
} from '../../src/db/index.js';
import { MockLlmProvider } from '../../src/llm/providers/mock.js';
import type { NewsItem, RawQuote, Signal } from '../../src/types/domain.js';

describe('briefing composer (Phase 3)', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;
  let llm: MockLlmProvider;
  const today = '2026-04-30';

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-briefing-${Date.now()}-${Math.random()}.db`);
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
    const quotes: RawQuote[] = [
      {
        symbol: 'RELIANCE',
        exchange: 'NSE',
        date: today,
        open: 2900,
        high: 2950,
        low: 2880,
        close: 2940,
        volume: 2_000_000,
        source: 'test',
      },
      {
        symbol: 'RELIANCE',
        exchange: 'NSE',
        date: '2026-04-29',
        open: 2850,
        high: 2910,
        low: 2840,
        close: 2900,
        volume: 1_500_000,
        source: 'test',
      },
    ];
    upsertQuotes(quotes, db);

    const signals: Signal[] = [
      { symbol: 'RELIANCE', date: today, name: 'rsi_14', value: 72, source: 'technical' },
    ];
    upsertSignals(signals, db);

    const news: NewsItem[] = [
      {
        headline: 'Reliance Q4 results beat estimates',
        source: 'ET Markets',
        url: 'https://example.com/reliance-q4',
        publishedAt: new Date().toISOString(),
        symbol: 'RELIANCE',
        sentiment: 0.7,
      },
    ];
    insertNews(news, db);

    upsertThesis(
      {
        symbol: 'RELIANCE',
        date: today,
        thesis:
          'Strong momentum near 52-week high with volume confirmation. Q4 results beat provides additional catalyst.',
        bullCase: ['Q4 beat', 'Near 52W high with volume'],
        bearCase: ['Rich valuation', 'Global crude risks'],
        entryZone: '₹2,900–₹2,940',
        stopLoss: '₹2,820',
        target: '₹3,100',
        timeHorizon: 'medium',
        confidenceScore: 7,
        triggerScreen: 'RSI overbought + volume spike',
        model: 'mock-model',
        raw: '{}',
      },
      db,
    );
  }

  it('composes briefing with AI sections when not skipped', async () => {
    const result = await composeBriefing({ date: today, watchlist: ['RELIANCE'] }, db, llm);

    expect(result.html).toContain('Market Pulse');
    expect(result.html).toContain('AI Picks');
    expect(result.html).toContain('RELIANCE');
    expect(result.html).toContain('Bull Case');
    expect(result.html).toContain('Bear Case');
    expect(result.html).toContain('₹2,900');
    expect(result.data.theses).toHaveLength(1);
    expect(result.data.aiPicksDisabled).toBeFalsy();
  });

  it('includes mood narrative from LLM', async () => {
    const result = await composeBriefing({ date: today, watchlist: ['RELIANCE'] }, db, llm);

    expect(result.data.moodNarrative).toBeTruthy();
    expect(result.html).toContain('mood-narrative');
    expect(llm.calls.some((c) => c.method === 'generateText')).toBe(true);
  });

  it('skips AI when skipAi=true', async () => {
    const result = await composeBriefing(
      { date: today, watchlist: ['RELIANCE'], skipAi: true },
      db,
      llm,
    );

    expect(result.data.aiPicksDisabled).toBe(true);
    expect(result.data.moodNarrative).toBeUndefined();
    expect(llm.calls).toHaveLength(0);
  });

  it('includes sentiment badges in news section', async () => {
    const result = await composeBriefing({ date: today, watchlist: ['RELIANCE'] }, db, llm);

    expect(result.html).toContain('sentiment-badge');
    expect(result.html).toContain('Bullish');
  });
});
