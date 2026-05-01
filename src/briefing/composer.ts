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
import { getAlertsForDate } from '../analysers/alerts.js';
import { loadScreens, loadWatchlist } from '../config/loaders.js';
import { getDb, getLatestHoldings, getPortfolioAnalysisForDate } from '../db/index.js';
import { getThesesForDate } from '../db/queries.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { getLlmProvider } from '../llm/index.js';
import type { LlmProvider } from '../llm/types.js';
import { child } from '../logger.js';
import { INDIA_VIX_BENCHMARK_SYMBOL, NIFTY_BENCHMARK_SYMBOL } from '../market/benchmarks.js';
import type { ScreenDefinition } from '../types/domain.js';
import {
  type AiPicksSectionStatus,
  type BriefingData,
  type MoverRow,
  type NewsRow,
  type PortfolioPositionCard,
  type PortfolioSummary,
  type ScreenMatch,
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
  /** Weekend / NSE holiday — banner only; callers should also skip pipeline LLMs. */
  marketClosure?: { kind: 'weekend' | 'holiday'; label: string };
  /** Populated when `generateTheses` ran in the same workflow — drives AI Picks empty-state copy. */
  thesisRun?: {
    generated: number;
    failed: number;
    candidateCount: number;
  };
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
  const allowMoodLlm = !opts.skipAi && !opts.marketClosure;

  const mood = gatherMood(date, db);
  const watchlistAlerts = gatherWatchlistAlerts(date, db);
  const topGainers = gatherMovers(date, watchlist, 'gainers', db);
  const topLosers = gatherMovers(date, watchlist, 'losers', db);
  const news = gatherNews(48, db);
  const theses = gatherTheses(date, db);
  const screenMatches = gatherScreenMatches(date, db);
  const portfolio = gatherPortfolio(date, db);

  let moodNarrative: string | undefined;
  if (
    allowMoodLlm &&
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

  const aiPicksStatus = resolveAiPicksStatus(
    Boolean(opts.skipAi),
    opts.marketClosure,
    theses.length,
    opts.thesisRun,
  );

  const data: BriefingData = {
    date,
    mood,
    moodNarrative,
    marketClosure: opts.marketClosure,
    watchlistAlerts,
    screenMatches: screenMatches.length > 0 ? screenMatches : undefined,
    portfolio,
    topGainers,
    topLosers,
    news,
    theses: theses.length > 0 ? theses : undefined,
    aiPicksStatus,
  };

  log.info(
    {
      date,
      watchlistAlerts: data.watchlistAlerts.length,
      screensFired: screenMatches.length,
      gainers: data.topGainers.length,
      losers: data.topLosers.length,
      news: data.news.length,
      theses: theses.length,
      portfolioHoldings: portfolio?.positions.length ?? 0,
      hasNarrative: !!moodNarrative,
    },
    'composed briefing payload',
  );

  return { date, html: renderBriefing(data), data };
}

function resolveAiPicksStatus(
  skipAi: boolean,
  marketClosure: ComposeBriefingOptions['marketClosure'],
  thesesLen: number,
  thesisRun?: ComposeBriefingOptions['thesisRun'],
): AiPicksSectionStatus {
  if (marketClosure) return { kind: 'holiday', label: marketClosure.label };
  if (skipAi) return { kind: 'skipped', reason: 'skip_ai_flag' };
  if (thesesLen > 0) return { kind: 'ok' };
  if (thesisRun && thesisRun.failed > 0 && thesisRun.generated === 0) {
    return { kind: 'all_failed', failed: thesisRun.failed };
  }
  return {
    kind: 'empty',
    reason: 'no_candidates',
    candidateCount: thesisRun?.candidateCount,
  };
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
      SELECT fii_net AS fiiNet, dii_net AS diiNet, date AS d
      FROM fii_dii
      WHERE date <= ? AND segment = 'cash'
      ORDER BY date DESC LIMIT 1
    `)
    .get(date) as { fiiNet?: number; diiNet?: number; d?: string } | undefined;

  const nifty = niftyChangeFromQuotes(NIFTY_BENCHMARK_SYMBOL, date, db);
  const vix = latestQuoteClose(INDIA_VIX_BENCHMARK_SYMBOL, date, db);

  return {
    fiiNet: row?.fiiNet,
    diiNet: row?.diiNet,
    fiiDiiDate: row?.d,
    niftyChangePct: nifty?.changePct,
    niftyBarDate: nifty?.asOf,
    vix: vix?.close,
    vixDate: vix?.asOf,
  };
}

function latestQuoteClose(
  symbol: string,
  date: string,
  db: DatabaseType,
): { close: number; asOf: string } | undefined {
  const latest = db
    .prepare(
      `
      SELECT date, close FROM quotes
      WHERE symbol = ? AND date <= ?
      ORDER BY date DESC LIMIT 1
    `,
    )
    .get(symbol, date) as { date: string; close: number } | undefined;
  if (!latest) return undefined;
  return { close: latest.close, asOf: latest.date };
}

function niftyChangeFromQuotes(
  symbol: string,
  date: string,
  db: DatabaseType,
): { changePct: number; asOf: string } | undefined {
  const latest = db
    .prepare(
      `
      SELECT date, close FROM quotes
      WHERE symbol = ? AND date <= ?
      ORDER BY date DESC LIMIT 1
    `,
    )
    .get(symbol, date) as { date: string; close: number } | undefined;
  if (!latest) return undefined;
  const prev = db
    .prepare(
      `
      SELECT close FROM quotes
      WHERE symbol = ? AND date < ?
      ORDER BY date DESC LIMIT 1
    `,
    )
    .get(symbol, latest.date) as { close: number } | undefined;
  if (!prev || prev.close <= 0) return { changePct: 0, asOf: latest.date };
  const changePct = ((latest.close - prev.close) / prev.close) * 100;
  return { changePct, asOf: latest.date };
}

/**
 * Read alerts from the `alerts` table. The Phase 2 alerts agent is
 * responsible for populating this — the briefing is now a pure read.
 */
function gatherWatchlistAlerts(date: string, db: DatabaseType): WatchlistAlert[] {
  const rows = getAlertsForDate(date, db);
  return rows.map((a) => ({
    symbol: a.symbol,
    signal: alertSignalLabel(a.kind),
    value: a.value,
    description: a.message,
  }));
}

function gatherPortfolio(date: string, db: DatabaseType): PortfolioSummary | undefined {
  const holdings = getLatestHoldings(db);
  if (holdings.length === 0) return undefined;
  const analysis = getPortfolioAnalysisForDate(date, db);
  const analysisBySymbol = new Map(analysis.map((a) => [a.symbol, a]));

  const positions: PortfolioPositionCard[] = holdings.map((h) => {
    const a = analysisBySymbol.get(h.symbol);
    return {
      symbol: h.symbol,
      qty: h.qty,
      avgPrice: h.avgPrice,
      lastPrice: h.lastPrice ?? null,
      pnl: h.pnl ?? null,
      pnlPct: h.pnlPct ?? null,
      dayChangePct: h.dayChangePct ?? null,
      action: a?.action ?? null,
      conviction: a?.conviction ?? null,
      thesis: a?.thesis ?? null,
      triggerReason: a?.triggerReason ?? null,
      bullPoints: a?.bullPoints ?? [],
      bearPoints: a?.bearPoints ?? [],
      suggestedStop: a?.suggestedStop ?? null,
      suggestedTarget: a?.suggestedTarget ?? null,
    };
  });

  let totalValue = 0;
  let totalCost = 0;
  let totalPnl = 0;
  let dayChangeAbs = 0;
  let hasDayChange = false;
  for (const h of holdings) {
    const px = h.lastPrice ?? h.avgPrice;
    totalValue += h.qty * px;
    totalCost += h.qty * h.avgPrice;
    if (h.pnl != null) totalPnl += h.pnl;
    if (h.dayChange != null) {
      dayChangeAbs += h.dayChange;
      hasDayChange = true;
    }
  }
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
  const previousValue = totalValue - dayChangeAbs;
  const dayChangePct =
    hasDayChange && previousValue > 0 ? (dayChangeAbs / previousValue) * 100 : null;

  return {
    totalValue,
    totalPnl,
    totalPnlPct,
    dayChange: hasDayChange ? dayChangeAbs : null,
    dayChangePct,
    source: (holdings[0]?.source as 'kite' | 'manual') ?? 'manual',
    positions,
  };
}

function alertSignalLabel(kind: string): string {
  switch (kind) {
    case 'rsi_overbought':
    case 'rsi_oversold':
      return 'RSI 14';
    case 'volume_spike':
      return 'Volume';
    case 'near_52w_high':
      return '52W High';
    case 'near_52w_low':
      return '52W Low';
    case 'stop_loss_breach':
      return 'Stop Loss';
    default:
      return kind;
  }
}

/**
 * Read today's screen matches from the `screens` table, grouped by
 * screen name, and decorate with the static screen metadata (label,
 * description, time horizon) from config.
 */
function gatherScreenMatches(date: string, db: DatabaseType): ScreenMatch[] {
  const rows = db
    .prepare(`
      SELECT screen_name AS screenName, symbol
      FROM screens
      WHERE date = ?
      ORDER BY screen_name, symbol
    `)
    .all(date) as Array<{ screenName: string; symbol: string }>;
  if (rows.length === 0) return [];

  const meta = new Map<string, ScreenDefinition>();
  try {
    for (const s of loadScreens()) meta.set(s.name, s);
  } catch {
    // No screens config — proceed with names only.
  }

  const grouped = new Map<string, ScreenMatch>();
  for (const r of rows) {
    let m = grouped.get(r.screenName);
    if (!m) {
      const def = meta.get(r.screenName);
      m = {
        screenName: r.screenName,
        screenLabel: def?.label ?? r.screenName,
        description: def?.description,
        timeHorizon: def?.timeHorizon,
        symbols: [],
      };
      grouped.set(r.screenName, m);
    }
    m.symbols.push(r.symbol);
  }
  return [...grouped.values()];
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
