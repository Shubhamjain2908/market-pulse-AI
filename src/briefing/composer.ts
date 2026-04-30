/**
 * Briefing composer. Gathers all data from the DB and optional AI layers
 * to produce a complete BriefingData payload, then renders HTML.
 *
 * Phase 3 additions:
 *   - LLM-generated market mood narrative
 *   - AI thesis cards from the `theses` table
 *   - Sentiment scores on news items
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { loadWatchlist } from '../config/loaders.js';
import { getDb } from '../db/index.js';
import { getThesesForDate } from '../db/queries.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { getLlmProvider } from '../llm/index.js';
import type { LlmProvider } from '../llm/types.js';
import { child } from '../logger.js';
import {
  type BriefingData,
  type MoverRow,
  type NewsRow,
  type ThesisCard,
  type WatchlistAlert,
  renderBriefing,
} from './template.js';

const log = child({ component: 'briefing-composer' });

export interface ComposeBriefingOptions {
  date?: string;
  watchlist?: string[];
  /** Skip all LLM calls (Phase 1 mode). */
  skipAi?: boolean;
}

export interface ComposedBriefing {
  date: string;
  html: string;
  data: BriefingData;
}

export async function composeBriefing(
  opts: ComposeBriefingOptions = {},
  db: DatabaseType = getDb(),
  llm?: LlmProvider,
): Promise<ComposedBriefing> {
  const date = opts.date ?? isoDateIst();
  const watchlist = (opts.watchlist ?? loadWatchlist().symbols).map((s) => s.toUpperCase());
  const useAi = !opts.skipAi;

  const mood = gatherMood(date, db);
  const watchlistAlerts = gatherWatchlistAlerts(date, watchlist, db);
  const topGainers = gatherMovers(date, watchlist, 'gainers', db);
  const topLosers = gatherMovers(date, watchlist, 'losers', db);
  const news = gatherNews(48, db);
  const theses = gatherTheses(date, db);

  let moodNarrative: string | undefined;
  if (
    useAi &&
    (mood.fiiNet != null || mood.diiNet != null || topGainers.length > 0 || topLosers.length > 0)
  ) {
    try {
      const provider = llm ?? getLlmProvider();
      moodNarrative = await generateMoodNarrative(
        mood,
        topGainers,
        topLosers,
        watchlistAlerts,
        provider,
      );
    } catch (err) {
      log.warn(
        { err: (err as Error).message },
        'mood narrative generation failed, continuing without it',
      );
    }
  }

  const data: BriefingData = {
    date,
    mood,
    moodNarrative,
    watchlistAlerts,
    topGainers,
    topLosers,
    news,
    theses: theses.length > 0 ? theses : undefined,
    aiPicksDisabled: !useAi,
  };

  log.info(
    {
      date,
      watchlistAlerts: data.watchlistAlerts.length,
      gainers: data.topGainers.length,
      losers: data.topLosers.length,
      news: data.news.length,
      theses: theses.length,
      hasNarrative: !!moodNarrative,
    },
    'composed briefing payload',
  );

  return { date, html: renderBriefing(data), data };
}

// ---------------------------------------------------------------------------
// AI: mood narrative
// ---------------------------------------------------------------------------

const MOOD_SYSTEM = `You are a concise financial journalist covering Indian equity markets.
Write a 2-4 sentence market mood summary for a morning briefing. Be factual, mention
specific numbers when available. Never give investment advice. Write in present tense.`;

async function generateMoodNarrative(
  mood: BriefingData['mood'],
  gainers: MoverRow[],
  losers: MoverRow[],
  alerts: WatchlistAlert[],
  llm: LlmProvider,
): Promise<string> {
  const dataPoints: string[] = [];
  if (mood.fiiNet != null) dataPoints.push(`FII net (cash): ₹${mood.fiiNet.toFixed(0)}Cr`);
  if (mood.diiNet != null) dataPoints.push(`DII net (cash): ₹${mood.diiNet.toFixed(0)}Cr`);
  if (mood.vix != null) dataPoints.push(`India VIX: ${mood.vix.toFixed(2)}`);
  if (mood.niftyChangePct != null)
    dataPoints.push(`Nifty change: ${mood.niftyChangePct.toFixed(2)}%`);
  const topGainer = gainers[0];
  if (topGainer)
    dataPoints.push(`Top gainer: ${topGainer.symbol} (+${topGainer.changePct.toFixed(1)}%)`);
  const topLoser = losers[0];
  if (topLoser)
    dataPoints.push(`Top loser: ${topLoser.symbol} (${topLoser.changePct.toFixed(1)}%)`);
  if (alerts.length > 0)
    dataPoints.push(`Active alerts: ${alerts.length} (${alerts.map((a) => a.symbol).join(', ')})`);

  const result = await llm.generateText({
    system: MOOD_SYSTEM,
    user: `Market data:\n${dataPoints.join('\n')}\n\nWrite a brief market mood summary.`,
    temperature: 0.3,
    maxOutputTokens: 300,
  });

  return result.text.trim();
}

// ---------------------------------------------------------------------------
// Thesis cards
// ---------------------------------------------------------------------------

function gatherTheses(date: string, db: DatabaseType): ThesisCard[] {
  const rows = getThesesForDate(date, db);
  return rows.map((r) => ({
    symbol: r.symbol,
    thesis: r.thesis,
    bullCase: r.bullCase,
    bearCase: r.bearCase,
    entryZone: r.entryZone,
    stopLoss: r.stopLoss,
    target: r.target,
    timeHorizon: r.timeHorizon,
    confidence: r.confidence,
    triggerReason: r.triggerReason,
  }));
}

// ---------------------------------------------------------------------------
// Section gatherers (data-only, no LLM)
// ---------------------------------------------------------------------------

function gatherMood(date: string, db: DatabaseType): BriefingData['mood'] {
  const row = db
    .prepare(`
      SELECT fii_net AS fiiNet, dii_net AS diiNet
      FROM fii_dii
      WHERE date <= ? AND segment = 'cash'
      ORDER BY date DESC LIMIT 1
    `)
    .get(date) as { fiiNet?: number; diiNet?: number } | undefined;

  return {
    fiiNet: row?.fiiNet,
    diiNet: row?.diiNet,
  };
}

interface SignalRow {
  symbol: string;
  rsi?: number;
  volRatio?: number;
  pctFromHigh?: number;
  pctFromLow?: number;
  close?: number;
  sma50?: number;
}

function loadSignalsForDate(
  date: string,
  symbols: string[],
  db: DatabaseType,
): Map<string, SignalRow> {
  if (symbols.length === 0) return new Map();
  const placeholders = symbols.map(() => '?').join(',');
  const rows = db
    .prepare(`
      SELECT symbol, name, value
      FROM signals
      WHERE date <= ? AND symbol IN (${placeholders})
        AND date = (
          SELECT MAX(date) FROM signals s2
          WHERE s2.symbol = signals.symbol AND s2.date <= ?
        )
    `)
    .all(date, ...symbols, date) as Array<{ symbol: string; name: string; value: number }>;

  const map = new Map<string, SignalRow>();
  for (const r of rows) {
    const entry = map.get(r.symbol) ?? { symbol: r.symbol };
    switch (r.name) {
      case 'rsi_14':
        entry.rsi = r.value;
        break;
      case 'volume_ratio_20d':
        entry.volRatio = r.value;
        break;
      case 'pct_from_52w_high':
        entry.pctFromHigh = r.value;
        break;
      case 'pct_from_52w_low':
        entry.pctFromLow = r.value;
        break;
      case 'close':
        entry.close = r.value;
        break;
      case 'sma_50':
        entry.sma50 = r.value;
        break;
      default:
        break;
    }
    map.set(r.symbol, entry);
  }
  return map;
}

function gatherWatchlistAlerts(
  date: string,
  watchlist: string[],
  db: DatabaseType,
): WatchlistAlert[] {
  const signals = loadSignalsForDate(date, watchlist, db);
  const alerts: WatchlistAlert[] = [];

  for (const symbol of watchlist) {
    const s = signals.get(symbol);
    if (!s) continue;

    if (s.rsi != null && s.rsi >= 70) {
      alerts.push({
        symbol,
        signal: 'RSI 14',
        value: s.rsi,
        description: 'Overbought - watch for pullback',
      });
    }
    if (s.rsi != null && s.rsi <= 30) {
      alerts.push({
        symbol,
        signal: 'RSI 14',
        value: s.rsi,
        description: 'Oversold - potential bounce',
      });
    }
    if (s.volRatio != null && s.volRatio >= 2) {
      alerts.push({
        symbol,
        signal: 'Volume',
        value: s.volRatio,
        description: 'Unusual volume - investigate news',
      });
    }
    if (s.pctFromHigh != null && s.pctFromHigh >= -2) {
      alerts.push({
        symbol,
        signal: '52W High',
        value: s.pctFromHigh,
        description: 'Within 2% of 52-week high',
      });
    }
    if (s.pctFromLow != null && s.pctFromLow <= 5) {
      alerts.push({
        symbol,
        signal: '52W Low',
        value: s.pctFromLow,
        description: 'Within 5% of 52-week low',
      });
    }
  }
  return alerts;
}

function gatherMovers(
  date: string,
  watchlist: string[],
  kind: 'gainers' | 'losers',
  db: DatabaseType,
  limit = 5,
): MoverRow[] {
  if (watchlist.length === 0) return [];
  const placeholders = watchlist.map(() => '?').join(',');
  const rows = db
    .prepare(`
      WITH latest AS (
        SELECT symbol, MAX(date) AS d
        FROM quotes
        WHERE date <= ? AND symbol IN (${placeholders})
        GROUP BY symbol
      )
      SELECT q.symbol, q.close, q.volume, q.date,
        (SELECT close FROM quotes p WHERE p.symbol = q.symbol AND p.date < q.date
         ORDER BY p.date DESC LIMIT 1) AS prevClose
      FROM quotes q
      JOIN latest l ON l.symbol = q.symbol AND l.d = q.date
    `)
    .all(date, ...watchlist) as Array<{
    symbol: string;
    close: number;
    volume: number;
    date: string;
    prevClose: number | null;
  }>;

  const movers: MoverRow[] = rows
    .filter((r) => r.prevClose && r.prevClose > 0)
    .map((r) => ({
      symbol: r.symbol,
      close: r.close,
      volume: r.volume,
      changePct: ((r.close - (r.prevClose as number)) / (r.prevClose as number)) * 100,
    }));

  movers.sort((a, b) =>
    kind === 'gainers' ? b.changePct - a.changePct : a.changePct - b.changePct,
  );
  return movers.slice(0, limit);
}

function gatherNews(hours: number, db: DatabaseType): NewsRow[] {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare(`
      SELECT headline, source, url, published_at AS publishedAt, symbol, sentiment
      FROM news
      WHERE published_at >= ?
      ORDER BY published_at DESC
      LIMIT 25
    `)
    .all(cutoff) as Array<NewsRow>;
  return rows;
}
