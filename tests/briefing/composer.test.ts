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
  upsertHoldings,
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
    expect(result.html).toContain('Nifty 50 spot');
    expect(result.html).not.toContain('GIFT Nifty');
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

  it('shows AI Picks empty copy when the watchlist overlaps holdings', async () => {
    const result = await composeBriefing(
      {
        date: today,
        watchlist: ['ZZTOP'],
        thesisRun: {
          generated: 0,
          failed: 0,
          candidateCount: 0,
          eligibleUniverseSize: 0,
          watchlistSize: 2,
        },
      },
      db,
      llm,
    );

    expect(result.data.aiPicksStatus).toEqual({
      kind: 'empty',
      reason: 'all_watchlist_owned',
      candidateCount: 0,
    });
    expect(result.html).toContain('already in My Portfolio');
  });

  it('includes portfolio risk rollup when holdings exist', async () => {
    upsertHoldings(
      [
        {
          symbol: 'INFY',
          exchange: 'NSE',
          asOf: today,
          qty: 10,
          avgPrice: 1500,
          lastPrice: 1450,
          pnl: -500,
          pnlPct: -3.3,
          dayChange: 0,
          dayChangePct: 0,
          product: 'CNC',
          source: 'kite',
        },
      ],
      db,
    );
    const result = await composeBriefing({ date: today, watchlist: ['RELIANCE'] }, db, llm);
    expect(result.html).toContain('Portfolio risk snapshot');
    expect(result.html).toContain('Top weights');
    expect(result.html).toContain('INFY');
  });

  it('drops US-stocks / live-blog / quote-of-the-day noise even when scored neutral', async () => {
    insertNews(
      [
        {
          headline: 'US stocks today-S&P 500, Nasdaq on course for best month',
          source: 'et-markets',
          url: 'https://economictimes.indiatimes.com/markets/us-stocks/news/us-stocks-today.cms',
          publishedAt: `${today}T12:00:00.000+05:30`,
          sentiment: 0.1,
        },
        {
          headline: 'Quote of the day by Michael Price',
          source: 'et-markets',
          url: 'https://economictimes.indiatimes.com/markets/us-stocks/news/quote-of-the-day-michael-price.cms',
          publishedAt: `${today}T11:00:00.000+05:30`,
          sentiment: 0.1,
        },
        {
          headline: 'US Stock Market Today Live',
          source: 'et-markets',
          url: 'https://economictimes.indiatimes.com/markets/us-stocks/news/liveblog/123.cms',
          publishedAt: `${today}T10:00:00.000+05:30`,
          sentiment: 0.1,
        },
      ],
      db,
    );

    const result = await composeBriefing({ date: today, watchlist: ['RELIANCE'] }, db, llm);
    const headlines = result.data.news.map((n) => n.headline);
    expect(headlines.some((h) => /US stocks today/i.test(h))).toBe(false);
    expect(headlines.some((h) => /Michael Price/i.test(h))).toBe(false);
    expect(headlines.some((h) => /US Stock Market Today Live/i.test(h))).toBe(false);
  });

  it('keeps domestic earnings catalysts even when sentiment is mildly positive', async () => {
    insertNews(
      [
        {
          headline: 'Mazagon Dock Q4 Results: Profit jumps 42% to Rs 464 crore',
          source: 'et-markets',
          url: 'https://economictimes.indiatimes.com/markets/stocks/earnings/mazagon-dock-q4.cms',
          publishedAt: `${today}T16:00:00.000+05:30`,
          sentiment: 0.45,
        },
        {
          headline: 'Equitas Small Finance Bank Q4 profit soars 5-fold',
          source: 'et-markets',
          url: 'https://economictimes.indiatimes.com/markets/stocks/earnings/equitas-q4.cms',
          publishedAt: `${today}T15:00:00.000+05:30`,
          sentiment: 0.45,
        },
      ],
      db,
    );

    const result = await composeBriefing({ date: today, watchlist: ['RELIANCE'] }, db, llm);
    const headlines = result.data.news.map((n) => n.headline);
    expect(headlines.some((h) => /Mazagon Dock/i.test(h))).toBe(true);
    expect(headlines.some((h) => /Equitas/i.test(h))).toBe(true);
  });

  it('keeps watchlist-tagged headlines regardless of sentiment magnitude', async () => {
    insertNews(
      [
        {
          headline: 'RELIANCE technical chart consolidates near support',
          source: 'et-markets',
          url: 'https://economictimes.indiatimes.com/markets/stocks/news/reliance-chart.cms',
          publishedAt: `${today}T14:00:00.000+05:30`,
          symbol: 'RELIANCE',
          sentiment: 0.05,
        },
      ],
      db,
    );

    const result = await composeBriefing({ date: today, watchlist: ['RELIANCE'] }, db, llm);
    expect(result.data.news.some((n) => n.symbol === 'RELIANCE')).toBe(true);
  });

  it('includes sentiment badges in news section', async () => {
    const result = await composeBriefing({ date: today, watchlist: ['RELIANCE'] }, db, llm);

    expect(result.html).toContain('sentiment-badge');
    expect(result.html).toContain('Bullish');
  });
});
