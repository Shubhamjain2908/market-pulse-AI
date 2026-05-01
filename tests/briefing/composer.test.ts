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
  upsertFiiDii,
  upsertQuotes,
  upsertSignals,
  upsertThesis,
} from '../../src/db/index.js';
import { MockLlmProvider } from '../../src/llm/providers/mock.js';
import type { FiiDiiRow, NewsItem, RawQuote, Signal } from '../../src/types/domain.js';

describe('briefing composer (Phase 3–4)', () => {
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

    const bench: RawQuote[] = [
      {
        symbol: 'NIFTY_50',
        exchange: 'NSE',
        date: today,
        open: 24000,
        high: 24100,
        low: 23900,
        close: 24080,
        volume: 0,
        source: 'test',
      },
      {
        symbol: 'NIFTY_50',
        exchange: 'NSE',
        date: '2026-04-29',
        open: 23900,
        high: 24050,
        low: 23880,
        close: 24000,
        volume: 0,
        source: 'test',
      },
      {
        symbol: 'DOW_JONES',
        exchange: 'NSE',
        date: today,
        open: 38000,
        high: 39000,
        low: 37800,
        close: 38600,
        volume: 0,
        source: 'test',
      },
      {
        symbol: 'DOW_JONES',
        exchange: 'NSE',
        date: '2026-04-29',
        open: 37500,
        high: 38100,
        low: 37400,
        close: 38000,
        volume: 0,
        source: 'test',
      },
      {
        symbol: 'INDIA_VIX',
        exchange: 'NSE',
        date: today,
        open: 14,
        high: 15,
        low: 13,
        close: 14.25,
        volume: 0,
        source: 'test',
      },
    ];
    upsertQuotes(bench, db);

    const fii: FiiDiiRow[] = [
      {
        date: today,
        segment: 'cash',
        fiiBuy: 10000,
        fiiSell: 9000,
        fiiNet: 8048,
        diiBuy: 5000,
        diiSell: 4800,
        diiNet: 200,
        source: 'test',
      },
    ];
    upsertFiiDii(fii, db);

    const signals: Signal[] = [
      { symbol: 'RELIANCE', date: today, name: 'rsi_14', value: 72, source: 'technical' },
    ];
    upsertSignals(signals, db);

    const news: NewsItem[] = [
      {
        headline: 'Reliance Q4 results beat estimates',
        source: 'ET Markets',
        url: 'https://example.com/reliance-q4',
        publishedAt: `${today}T10:30:00.000+05:30`,
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
    expect(result.html).toContain('Why now:');
    expect(result.html).toContain('₹2,900');
    expect(result.html).toContain('Global Cues');
    expect(result.html).toContain('Dow Jones');
    expect(result.html).toContain('#1 by signal score');
    expect(result.data.theses).toHaveLength(1);
    expect(result.data.aiPicksStatus.kind).toBe('ok');
  });

  it('respects moodNarrativeDisabled', async () => {
    const result = await composeBriefing(
      { date: today, watchlist: ['RELIANCE'], moodNarrativeDisabled: true },
      db,
      llm,
    );
    expect(result.data.moodNarrative).toBeUndefined();
    expect(llm.calls.filter((c) => c.method === 'generateText')).toHaveLength(0);
  });

  it('respects newsWindowHours and newsLimit', async () => {
    insertNews(
      [
        {
          headline: 'Fresh headline',
          source: 'Test',
          url: 'https://example.com/fresh',
          publishedAt: `${today}T12:00:00.000+05:30`,
        },
        {
          headline: 'Stale headline',
          source: 'Test',
          url: 'https://example.com/stale',
          publishedAt: '2026-04-28T12:00:00.000+05:30',
        },
      ],
      db,
    );
    const result = await composeBriefing(
      { date: today, watchlist: ['RELIANCE'], newsWindowHours: 24, newsLimit: 5 },
      db,
      llm,
    );
    expect(result.data.news.some((n) => n.headline === 'Fresh headline')).toBe(true);
    expect(result.data.news.some((n) => n.headline === 'Stale headline')).toBe(false);
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

    expect(result.data.aiPicksStatus).toMatchObject({
      kind: 'skipped',
      reason: 'skip_ai_flag',
    });
    expect(result.data.moodNarrative).toBeUndefined();
    expect(llm.calls).toHaveLength(0);
  });

  it('shows holiday messaging when marketClosure is set', async () => {
    const result = await composeBriefing(
      {
        date: '2026-05-01',
        skipAi: true,
        marketClosure: { kind: 'holiday', label: 'Maharashtra Day' },
        watchlist: ['RELIANCE'],
      },
      db,
      llm,
    );

    expect(result.data.aiPicksStatus).toEqual({
      kind: 'holiday',
      label: 'Maharashtra Day',
    });
    expect(result.html).toContain('NSE closed');
    expect(result.html).toContain('Maharashtra Day');
  });

  it('includes sentiment badges in news section', async () => {
    const result = await composeBriefing({ date: today, watchlist: ['RELIANCE'] }, db, llm);

    expect(result.html).toContain('sentiment-badge');
    expect(result.html).toContain('Bullish');
  });
});
