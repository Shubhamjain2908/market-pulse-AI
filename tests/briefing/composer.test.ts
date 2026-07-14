import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeBriefing, validateMoodNarrative } from '../../src/briefing/composer.js';
import {
  closeDb,
  getDb,
  getOpenPaperTrades,
  insertNews,
  insertPaperTradeIfAbsent,
  insertStopLog,
  migrate,
  upsertFiiDii,
  upsertHoldings,
  upsertPortfolioAnalysis,
  upsertQuotes,
  upsertSignals,
  upsertThesis,
} from '../../src/db/index.js';
import { MockLlmProvider } from '../../src/llm/providers/mock.js';
import type { LlmJsonResult, LlmProvider, LlmTextResult } from '../../src/llm/types.js';
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

  it('includes trailing stop card when EOD log rows exist for the briefing date', async () => {
    insertPaperTradeIfAbsent(
      {
        symbol: 'TRAILTEST',
        signalType: 'AI_PICK',
        sourceDate: '2026-04-01',
        entryPrice: 100,
        stopLoss: 90,
        target: 120,
        timeHorizon: 'medium',
        maxHoldDays: 90,
      },
      db,
    );
    const trail = getOpenPaperTrades(db).find((t) => t.symbol === 'TRAILTEST');
    if (!trail) throw new Error('missing TRAILTEST trade');
    insertStopLog(
      {
        tradeId: trail.id,
        symbol: 'TRAILTEST',
        logDate: today,
        prevStop: 90,
        newStop: 94,
        stopDelta: 4,
        candidateStop: 93,
        highestClose: 100,
        atr14Today: 3,
        multiplierUsed: 2,
        unrealisedPct: 5,
        action: 'RAISED',
      },
      db,
    );
    const result = await composeBriefing({ date: today, watchlist: ['RELIANCE'] }, db, llm);
    expect(result.html).toContain('Paper trades · trailing stops');
    expect(result.html).toContain('TRAILTEST');
    expect(result.html).toContain('Raised');
  });

  it('places momentum card between screens and watchlist when open momentum_mf trades exist', async () => {
    insertPaperTradeIfAbsent(
      {
        symbol: 'TCS',
        signalType: 'momentum_mf',
        sourceDate: '2026-04-01',
        entryPrice: 3500,
        stopLoss: 3300,
        target: 3800,
        timeHorizon: 'medium',
        maxHoldDays: 90,
      },
      db,
    );
    upsertQuotes(
      [
        {
          symbol: 'TCS',
          exchange: 'NSE',
          date: today,
          open: 3400,
          high: 3550,
          low: 3380,
          close: 3520,
          volume: 1_000_000,
          source: 'test',
        },
      ],
      db,
    );
    upsertSignals(
      [{ symbol: 'TCS', date: today, name: 'mom_rank', value: 17, source: 'momentum' }],
      db,
    );
    db.prepare(
      `
      INSERT INTO screens (symbol, date, screen_name, score, matched_criteria)
      VALUES ('RELIANCE', ?, 'test_screen', 1, '{}')
    `,
    ).run(today);
    const result = await composeBriefing({ date: today, watchlist: ['RELIANCE'] }, db, llm);
    const { html } = result;
    const iScreens = html.indexOf('Screens Fired Today');
    const iMom = html.indexOf('Momentum screener');
    const iWatch = html.indexOf('Watchlist Alerts');
    expect(iScreens).toBeGreaterThan(-1);
    expect(iMom).toBeGreaterThan(-1);
    expect(iWatch).toBeGreaterThan(-1);
    expect(iScreens).toBeLessThan(iMom);
    expect(iMom).toBeLessThan(iWatch);
    expect(html).toContain('Rank decay watch');
    expect(html).toContain('TCS');
  });

  it('falls back to deterministic mood narrative when LLM returns invalid replies repeatedly', async () => {
    let badCalls = 0;
    const badLlm: LlmProvider = {
      name: 'bad',
      model: 'bad',
      async generateText(): Promise<LlmTextResult> {
        badCalls++;
        return { text: 'Aggressive', model: 'bad', usage: { durationMs: 1 } };
      },
      async generateJson<T>(): Promise<LlmJsonResult<T>> {
        throw new Error('not used in this test');
      },
    };
    const result = await composeBriefing({ date: today, watchlist: ['RELIANCE'] }, db, badLlm);
    expect(result.data.moodNarrative).toBeTruthy();
    expect(result.data.moodNarrative).toContain('Watch:');
    expect(result.html).toMatch(/<div class="mood-narrative"[^>]*>/);
    expect(badCalls).toBeGreaterThanOrEqual(2);
  });

  it('retries once and uses mood narrative when the second attempt is valid', async () => {
    let textCalls = 0;
    const recoverLlm: LlmProvider = {
      name: 'recover',
      model: 'recover',
      async generateText(): Promise<LlmTextResult> {
        textCalls++;
        const text =
          textCalls === 1
            ? 'Short'
            : 'Domestic institutions provide a cushion as overseas investors remain selective. The tape shows narrow leadership with higher volatility. Watch: rate path, flows, and large-cap earnings.';
        return { text, model: 'recover', usage: { durationMs: 1 } };
      },
      async generateJson<T>(): Promise<LlmJsonResult<T>> {
        throw new Error('not used in this test');
      },
    };
    const result = await composeBriefing({ date: today, watchlist: ['RELIANCE'] }, db, recoverLlm);
    expect(textCalls).toBe(2);
    expect(result.data.moodNarrative).toBeTruthy();
    expect(result.html).toContain('mood-narrative');
  });

  it('falls back to deterministic mood narrative when both LLM attempts fail', async () => {
    let genCalls = 0;
    const fallbackLlm: LlmProvider = {
      name: 'fallback',
      model: 'fallback',
      async generateText(): Promise<LlmTextResult> {
        genCalls++;
        return { text: 'Bad', model: 'fallback', usage: { durationMs: 1 } };
      },
      async generateJson<T>(): Promise<LlmJsonResult<T>> {
        throw new Error('not used');
      },
    };
    const result = await composeBriefing({ date: today, watchlist: ['RELIANCE'] }, db, fallbackLlm);
    expect(genCalls).toBe(2);
    expect(result.data.moodNarrative).toBeTruthy();
    expect(result.data.moodNarrative).toContain('Watch:');
    expect(result.html).toMatch(/<div class="mood-narrative"[^>]*>/);
  });

  it('skips AI when skipAi=true and no persisted theses', async () => {
    const result = await composeBriefing(
      { date: today, watchlist: ['INFY'], skipAi: true },
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

  it('shows persisted theses when skipAi=true', async () => {
    const result = await composeBriefing(
      { date: today, watchlist: ['RELIANCE'], skipAi: true },
      db,
      llm,
    );

    expect(result.data.aiPicksStatus.kind).toBe('ok');
    expect(result.data.theses).toHaveLength(1);
    expect(result.html).toContain('RELIANCE');
    expect(result.html).not.toContain('--skip-ai');
  });

  it('renders persisted theses without admitting trades during EOD reconciliation', async () => {
    db.prepare(
      `INSERT INTO screens (symbol, date, screen_name, score, matched_criteria)
       VALUES ('RELIANCE', ?, 'rsi_oversold_bounce', 1, '{}')`,
    ).run(today);
    upsertSignals(
      [
        {
          symbol: 'RELIANCE',
          date: today,
          name: 'mom_earnings_blackout',
          value: 0,
          source: 'momentum',
        },
      ],
      db,
    );

    const result = await composeBriefing(
      {
        date: today,
        watchlist: ['RELIANCE'],
        skipAi: true,
        admitNewPaperTrades: false,
      },
      db,
      llm,
    );

    expect(result.data.theses).toHaveLength(1);
    expect(result.html).toContain('RELIANCE');
    expect(getOpenPaperTrades(db)).toHaveLength(0);
  });

  it('surfaces the AI_PICK earnings blackout reason while retaining the thesis', async () => {
    upsertSignals(
      [
        {
          symbol: 'RELIANCE',
          date: today,
          name: 'mom_earnings_blackout',
          value: 1,
          source: 'momentum',
        },
      ],
      db,
    );

    const result = await composeBriefing(
      { date: today, watchlist: ['RELIANCE'], skipAi: true },
      db,
      llm,
    );

    expect(result.data.theses).toHaveLength(1);
    expect(result.html).toContain('AI_PICK admission');
    expect(result.html).toContain('RELIANCE — earnings blackout active');
    expect(getOpenPaperTrades(db)).toHaveLength(0);
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

  it('explains Proposed to Effective Action overrides in the portfolio card', async () => {
    upsertHoldings(
      [
        {
          symbol: 'SAIL',
          exchange: 'NSE',
          asOf: today,
          qty: 10,
          avgPrice: 100,
          lastPrice: 95,
          source: 'manual',
        },
      ],
      db,
    );
    upsertPortfolioAnalysis(
      [
        {
          symbol: 'SAIL',
          date: today,
          proposedAction: 'HOLD',
          action: 'TRIM',
          actionOverrideReason: 'Quality deterioration requires de-risking',
          conviction: 0.7,
          thesis: 'Wait for operating performance to stabilise.',
          bullPoints: ['Valuation support'],
          bearPoints: ['Weak quality trend'],
          triggerReason: 'Quality deterioration requires de-risking',
          model: 'mock',
        },
      ],
      db,
    );

    const result = await composeBriefing(
      { date: today, skipAi: true, admitNewPaperTrades: false },
      db,
      llm,
    );

    expect(result.html).toContain('System override:');
    expect(result.html).toContain('Proposed HOLD → Effective TRIM');
    expect(result.html).toContain('Reason:</span> Quality deterioration requires de-risking');
    expect(result.html).toContain('Underlying analysis:');
    expect(result.html.indexOf('Effective: TRIM')).toBeLessThan(
      result.html.indexOf('Proposed: HOLD'),
    );
  });

  it('classifies ETF/SGB sectors in portfolio risk rollup', async () => {
    upsertHoldings(
      [
        {
          symbol: 'GOLDBEES',
          exchange: 'NSE',
          asOf: today,
          qty: 100,
          avgPrice: 60,
          lastPrice: 62,
          pnl: 200,
          pnlPct: 3,
          dayChange: 0,
          dayChangePct: 0,
          product: 'CNC',
          source: 'kite',
        },
      ],
      db,
    );
    const result = await composeBriefing({ date: today, watchlist: ['RELIANCE'] }, db, llm);
    expect(result.html).toContain('Gold ETF');
  });

  it('validates mood narrative length and sentence punctuation', () => {
    expect(() =>
      validateMoodNarrative(
        'Flows skew cautious while domestic buyers stabilise the tape. India VIX implies event risk into macro prints. Watch: HDFC Bank, crude, and US futures.',
      ),
    ).not.toThrow();
    expect(() => validateMoodNarrative('Aggressive')).toThrow();
    expect(() => validateMoodNarrative('Only three words here')).toThrow();
  });

  it('includes signal performance (paper) section', async () => {
    const result = await composeBriefing({ date: today, watchlist: ['RELIANCE'] }, db, llm);
    expect(result.html).toMatch(/class="card signal-performance"/);
    expect(result.html).toContain('Signal performance (paper)');
  });

  it('includes sentiment badges in news section', async () => {
    const result = await composeBriefing({ date: today, watchlist: ['RELIANCE'] }, db, llm);

    expect(result.html).toContain('sentiment-badge');
    expect(result.html).toContain('Bullish');
  });
});
