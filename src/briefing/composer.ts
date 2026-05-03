/**
 * Briefing composer. Gathers all data from the DB and optional AI layers
 * to produce a complete BriefingData payload, then renders HTML.
 *
 * Includes mood narrative, thesis cards, sentiment on news, and (report quality
 * Phase 3) briefing-relative news selection with dedupe plus HTML ledes for
 * clearer action framing.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { technicalSummaryLine } from '../agents/portfolio-trigger.js';
import { getThesisRankMeta } from '../agents/thesis-generator.js';
import { getAlertsForDate } from '../analysers/alerts.js';
import { config } from '../config/env.js';
import { loadScreens, loadSectorMap, loadWatchlist } from '../config/loaders.js';
import {
  type PortfolioHoldingRow,
  getDb,
  getLatestHoldings,
  getPortfolioAnalysisForDate,
} from '../db/index.js';
import { getPaperTradeStats, getSymbolSectors, getThesesForDate } from '../db/queries.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { getLlmProvider } from '../llm/index.js';
import type { LlmProvider } from '../llm/types.js';
import { child } from '../logger.js';
import { INDIA_VIX_BENCHMARK_SYMBOL, NIFTY_BENCHMARK_SYMBOL } from '../market/benchmarks.js';
import { gatherGlobalCues } from '../market/global-cues.js';
import { latestQuoteClose, sessionChangeVsPriorClose } from '../market/quote-change.js';
import type { ScreenDefinition } from '../types/domain.js';
import { recordPaperTrades } from './paper-trade-writer.js';
import { classifySector } from './sector-classifier.js';
import {
  type AiPicksSectionStatus,
  type BriefingData,
  type MoverRow,
  type NewsRow,
  type PortfolioPositionCard,
  type PortfolioRiskRollup,
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
    eligibleUniverseSize: number;
    watchlistSize: number;
  };
  /** Override `config.BRIEFING_NEWS_WINDOW_HOURS` (e.g. tests). */
  newsWindowHours?: number;
  /** Override `config.BRIEFING_NEWS_LIMIT`. */
  newsLimit?: number;
  /** Force-disable mood LLM even when AI is enabled. */
  moodNarrativeDisabled?: boolean;
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
  const moodNarrativeEnabled =
    config.BRIEFING_MOOD_NARRATIVE !== '0' && !opts.moodNarrativeDisabled;

  const mood = gatherMood(date, db);
  const globalCues = gatherGlobalCues(date, db);
  const watchlistAlerts = gatherWatchlistAlerts(date, db);
  const topGainers = gatherMovers(date, watchlist, 'gainers', db);
  const topLosers = gatherMovers(date, watchlist, 'losers', db);
  const newsHours = opts.newsWindowHours ?? config.BRIEFING_NEWS_WINDOW_HOURS;
  const newsLimit = opts.newsLimit ?? config.BRIEFING_NEWS_LIMIT;
  const news = gatherNews(newsHours, date, watchlist, db, newsLimit);
  const holdingsSet = new Set(getLatestHoldings(db).map((h) => h.symbol.toUpperCase()));
  const thesisUniverse = watchlist.filter((s) => !holdingsSet.has(s.toUpperCase()));
  const thesisEligibleSet = new Set(thesisUniverse.map((s) => s.toUpperCase()));
  const rankMeta =
    !opts.skipAi && !opts.marketClosure ? getThesisRankMeta(date, thesisUniverse, db) : undefined;
  const theses = gatherTheses(date, db, rankMeta, thesisEligibleSet);
  const screenMatches = gatherScreenMatches(date, db);
  const portfolio = gatherPortfolio(date, db);

  const paperLog = recordPaperTrades(date, theses, portfolio, db);
  if (paperLog.insertedAiPick > 0 || paperLog.insertedPortfolioAdd > 0) {
    log.info(paperLog, 'paper trades recorded');
  }

  const statsRaw = getPaperTradeStats({ days: 30, asOf: date }, db);
  const signalPerformance = {
    windowDays: statsRaw.windowDays,
    closed: statsRaw.closedCount,
    open: statsRaw.openCount,
    winRate: statsRaw.winRate,
    avgWinnerPct: statsRaw.avgWinnerPct,
    avgLoserPct: statsRaw.avgLoserPct,
    expectancyPct: statsRaw.expectancyPct,
    minSampleMet: statsRaw.minSampleMet,
  };

  let moodNarrative: string | undefined;
  if (
    allowMoodLlm &&
    moodNarrativeEnabled &&
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
    globalCues,
    moodNarrative,
    marketClosure: opts.marketClosure,
    watchlistAlerts,
    signalPerformance,
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
  if (
    thesisRun &&
    thesesLen === 0 &&
    thesisRun.eligibleUniverseSize === 0 &&
    thesisRun.watchlistSize > 0
  ) {
    return {
      kind: 'empty',
      reason: 'all_watchlist_owned',
      candidateCount: thesisRun.candidateCount,
    };
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

The reader already sees exact FII/DII, India VIX, and Nifty figures in the Market Mood grid
above your paragraph — do NOT repeat those numbers or restate that table.

Write 2 to 3 complete sentences (40–90 words total, one short paragraph):
- Connect flows, volatility tone, and index direction into one coherent read (risk-on/off,
  domestic cushion vs foreign selling, breadth hints from the movers/alerts context).
- Do not invent statistics; only interpret what is implied by the facts supplied below.

End with exactly one sentence that starts with "Watch:" and lists concrete subjects to
monitor (sectors, flow tension, macro prints, upcoming events) — not buy/sell wording.

Never respond with a single word or fragment. If the data is sparse, still write a coherent
two-sentence read plus the Watch sentence.

Never give investment advice. Present tense. Avoid generic filler ("mixed signals",
"cautious optimism") unless you tie it to a specific fact from the data.`;

/** Fallback when the full paragraph fails validation: tiny payload, one sentence, ~80 tokens max. */
const MOOD_MINI_SYSTEM = `You write one sentence only about Indian equity session tone.

You MUST output exactly one English sentence ending with . ! or ?
Use the four numeric inputs as given (FII/DII in ₹ crore cash; India VIX level; Nifty cash index % change).
Interpret how flows, volatility, and the index move relate — you may cite these figures in the sentence.

No "Watch:" line. No bullet points. No investment advice. Present tense.`;

/** Rejects truncated / safety-filter one-word outputs so the briefing can omit the block. */
export function validateMoodNarrative(text: string): void {
  const t = text.trim();
  if (t.length < 25) throw new Error('mood narrative too short');
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 2) throw new Error('mood narrative too few words');
  if (!/[.!?]/.test(t)) throw new Error('mood narrative missing sentence terminator');
}

/** Validates the compact single-sentence fallback from {@link generateMoodNarrativeMini}. */
export function validateMoodNarrativeMini(text: string): void {
  const t = text.trim();
  if (t.length < 35) throw new Error('mini mood narrative too short');
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 12) throw new Error('mini mood narrative too few words');
  if (!/[.!?]/.test(t)) throw new Error('mini mood narrative missing sentence terminator');
  const sentences = t.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  if (sentences.length !== 1) throw new Error('mini mood narrative must be one sentence');
}

/** Non-LLM fallback when Vertex returns empty candidates twice (mood + mini). */
function buildDeterministicMoodNarrative(mood: BriefingData['mood']): string {
  const flowBits: string[] = [];
  if (mood.fiiNet != null) {
    const d = mood.fiiNet >= 0 ? 'net buying' : 'net selling';
    flowBits.push(`FII cash ${d} of about ₹${Math.abs(mood.fiiNet).toFixed(0)} Cr`);
  }
  if (mood.diiNet != null) {
    const d = mood.diiNet >= 0 ? 'supportive' : 'soft';
    flowBits.push(`DII flows look ${d} near ₹${Math.abs(mood.diiNet).toFixed(0)} Cr`);
  }
  if (mood.vix != null) flowBits.push(`India VIX printed ${mood.vix.toFixed(2)}`);
  if (mood.niftyChangePct != null) {
    flowBits.push(
      `Nifty moved ${mood.niftyChangePct >= 0 ? '+' : ''}${mood.niftyChangePct.toFixed(2)}%`,
    );
  }
  const core =
    flowBits.length > 0
      ? `Session tone reflects ${flowBits.join(', ')}, reading cross-currents between foreign portfolio flows and local liquidity.`
      : 'Session tone is data-light until fresh FII/DII and benchmark prints populate; treat positioning as cautious and event-driven.';
  return `${core} Watch: how the tape balances global cues against domestic flows in upcoming sessions.`;
}

async function generateMoodNarrativeMini(
  mood: BriefingData['mood'],
  llm: LlmProvider,
): Promise<string> {
  const payload = {
    fiiNetCr: mood.fiiNet,
    diiNetCr: mood.diiNet,
    vix: mood.vix,
    niftyChangePct: mood.niftyChangePct,
  };
  const result = await llm.generateText({
    system: MOOD_MINI_SYSTEM,
    user: `session_metrics_json:\n${JSON.stringify(payload)}\n\nWrite the single sentence.`,
    temperature: 0.2,
    maxOutputTokens: 80,
  });
  const text = result.text.trim();
  validateMoodNarrativeMini(text);
  return text;
}

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

  const baseUser = `Facts for interpretation (do not quote numbers back verbatim):\n${dataPoints.join('\n')}\n\nWrite the mood paragraph per instructions.`;

  try {
    let result = await llm.generateText({
      system: MOOD_SYSTEM,
      user: baseUser,
      temperature: 0.25,
      maxOutputTokens: 220,
    });
    let text = result.text.trim();
    try {
      validateMoodNarrative(text);
      return text;
    } catch {
      result = await llm.generateText({
        system: MOOD_SYSTEM,
        user: `${baseUser}\n\nTwo complete sentences plus the Watch sentence.`,
        temperature: 0.25,
        maxOutputTokens: 220,
      });
      text = result.text.trim();
      validateMoodNarrative(text);
      return text;
    }
  } catch {
    try {
      return await generateMoodNarrativeMini(mood, llm);
    } catch {
      return buildDeterministicMoodNarrative(mood);
    }
  }
}

// ---------------------------------------------------------------------------
// Thesis cards
// ---------------------------------------------------------------------------

function gatherTheses(
  date: string,
  db: DatabaseType,
  rankMeta?: Map<string, { rank: number; reasonsLine: string }>,
  /** When set, only show thesis cards for symbols eligible for AI Picks (watchlist ∩ ¬holdings). */
  eligibleSymbols?: Set<string>,
): ThesisCard[] {
  const rows = getThesesForDate(date, db);
  const filtered =
    eligibleSymbols != null
      ? rows.filter((r) => eligibleSymbols.has(r.symbol.toUpperCase()))
      : rows;
  return filtered.map((r) => {
    const meta = rankMeta?.get(r.symbol);
    return {
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
      rank: meta?.rank,
      rankBlurb: meta?.reasonsLine,
    };
  });
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

  const nifty = sessionChangeVsPriorClose(NIFTY_BENCHMARK_SYMBOL, date, db);
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
  const sectorMap = loadSectorMap();
  const sectorFromDb = getSymbolSectors(
    holdings.map((h) => h.symbol),
    db,
  );
  const riskRollup = buildPortfolioRiskRollup(holdings, sectorMap, sectorFromDb);

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
      technicalSummary: technicalSummaryLine(h.symbol, date, db),
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
    riskRollup,
  };
}

function buildPortfolioRiskRollup(
  holdings: PortfolioHoldingRow[],
  sectorMap: Record<string, string>,
  sectorFromDb: Map<string, string>,
): PortfolioRiskRollup | undefined {
  if (holdings.length === 0) return undefined;

  const enriched = holdings.map((h) => {
    const px = h.lastPrice ?? h.avgPrice;
    const valueInr = h.qty * px;
    return { ...h, valueInr };
  });

  const totalValue = enriched.reduce((s, p) => s + p.valueInr, 0);
  if (totalValue <= 0) return undefined;

  const topWeights = [...enriched]
    .sort((a, b) => b.valueInr - a.valueInr)
    .slice(0, 5)
    .map((p) => ({
      symbol: p.symbol,
      weightPct: (p.valueInr / totalValue) * 100,
      valueInr: p.valueInr,
    }));

  const topLosers = enriched
    .filter((p) => p.pnlPct != null && p.pnlPct < 0)
    .sort((a, b) => (a.pnlPct ?? 0) - (b.pnlPct ?? 0))
    .slice(0, 3)
    .map((p) => ({
      symbol: p.symbol,
      pnlPct: p.pnlPct ?? 0,
      pnlInr: p.pnl ?? 0,
    }));

  const drawdownBuckets = {
    gt0: 0,
    zeroToNeg10: 0,
    neg10ToNeg20: 0,
    ltNeg20: 0,
  };
  for (const p of enriched) {
    const pct = p.pnlPct;
    if (pct == null) continue;
    if (pct > 0) drawdownBuckets.gt0++;
    else if (pct >= -10) drawdownBuckets.zeroToNeg10++;
    else if (pct >= -20) drawdownBuckets.neg10ToNeg20++;
    else drawdownBuckets.ltNeg20++;
  }

  const sectorAgg = new Map<string, number>();
  for (const p of enriched) {
    const sector = classifySector(p.symbol, sectorMap, sectorFromDb.get(p.symbol.toUpperCase()));
    sectorAgg.set(sector, (sectorAgg.get(sector) ?? 0) + p.valueInr);
  }
  const sectorWeights = [...sectorAgg.entries()]
    .map(([sector, v]) => ({
      sector,
      weightPct: (v / totalValue) * 100,
    }))
    .sort((a, b) => b.weightPct - a.weightPct);

  return {
    topWeights,
    topLosers,
    drawdownBuckets,
    sectorWeights,
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

function normalizeNewsHeadline(headline: string): string {
  return headline.trim().replace(/\s+/g, ' ').toLowerCase();
}

function newsRelevanceScore(n: NewsRow, watchlist: Set<string>): number {
  const sym = n.symbol?.toUpperCase();
  if (sym && watchlist.has(sym)) return 4;
  if (sym) return 2;
  return 1;
}

/**
 * Deterministic noise patterns: feeds that are not actionable for an Indian-equity
 * watchlist briefing. Sentiment scoring is unreliable here (the LLM keeps returning
 * 0.10 for "any-financial-context" headlines), so we strip them by URL/source before
 * any sentiment-based filtering.
 */
const NOISE_URL_PATTERNS: RegExp[] = [
  /\/markets\/us-stocks\//i,
  /\/quote-of-the-day-/i,
  /\/liveblog\//i,
];

export function isNoiseHeadline(n: { url: string }): boolean {
  return NOISE_URL_PATTERNS.some((re) => re.test(n.url));
}

/**
 * Sentiment magnitude required to keep a non-watchlist, untagged headline.
 * Set deliberately below the architect's `0.3` cutoff so that domestic earnings
 * the LLM under-scores at `0.10` (e.g. "Q4 profit jumps 42%") still survive
 * after the enricher's keyword nudge lifts them above this floor.
 */
const NEWS_SENTIMENT_KEEP_MAGNITUDE = 0.2;

/**
 * Pulls recent headlines anchored to the briefing calendar date (replay-safe),
 * removes deterministic noise (US-stocks live blogs, "quote of the day", etc.),
 * drops duplicate headlines, and applies a sentiment-magnitude floor while
 * always keeping watchlist-tagged items.
 */
function gatherNews(
  hours: number,
  briefingDate: string,
  watchlistSymbols: string[],
  db: DatabaseType,
  limit = 20,
): NewsRow[] {
  const watchlist = new Set(watchlistSymbols.map((s) => s.toUpperCase()));
  const windowEnd = new Date(`${briefingDate}T23:59:59.999+05:30`);
  const windowStart = new Date(windowEnd.getTime() - hours * 60 * 60 * 1000);
  const startIso = windowStart.toISOString();
  const endIso = windowEnd.toISOString();

  const rows = db
    .prepare(`
      SELECT headline, source, url, published_at AS publishedAt, symbol, sentiment
      FROM news
      WHERE published_at >= ? AND published_at <= ?
      ORDER BY published_at DESC
      LIMIT 120
    `)
    .all(startIso, endIso) as NewsRow[];

  const seen = new Set<string>();
  const deduped: NewsRow[] = [];
  for (const r of rows) {
    if (isNoiseHeadline(r)) continue;
    const key = normalizeNewsHeadline(r.headline);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }

  const filtered = deduped.filter((n) => {
    const sym = n.symbol?.toUpperCase();
    if (sym && watchlist.has(sym)) return true;
    if (n.sentiment == null) return true;
    return Math.abs(n.sentiment) >= NEWS_SENTIMENT_KEEP_MAGNITUDE;
  });

  filtered.sort((a, b) => {
    const ra = newsRelevanceScore(a, watchlist);
    const rb = newsRelevanceScore(b, watchlist);
    if (rb !== ra) return rb - ra;
    return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
  });

  return filtered.slice(0, limit);
}
