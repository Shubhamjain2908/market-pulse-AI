/**
 * Thesis generator agent. For each screened or watchlisted name with interesting
 * signals, assembles data context (quotes, fundamentals, signals, news) and asks
 * the LLM for a structured Thesis.
 *
 * Candidate pool: today's `screens` hits ∪ watchlist, minus holdings and OPEN paper trades.
 * The output is persisted to `theses` and surfaced in the briefing AI Picks section.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import pLimit from 'p-limit';
import { computeRubricAnchors, computeRubricTotal } from '../analysers/thesis-rubric.js';
import { config } from '../config/env.js';
import {
  type ExtSignalProviderFile,
  loadExtSignalProvider,
  loadWatchlist,
} from '../config/loaders.js';
import { getDb, getLatestHoldings, isStrategyAllowed } from '../db/index.js';
import {
  getDistinctOpenPaperTradeSymbols,
  getLatestConcallIntel,
  getThesesForDate,
  type StoredThesis,
  type UpsertThesisRow,
  upsertThesis,
} from '../db/queries.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { getLlmProvider } from '../llm/index.js';
import type { LlmProvider } from '../llm/types.js';
import { child } from '../logger.js';
import { type Thesis, ThesisSchema } from '../types/domain.js';
import type { Regime } from '../types/regime.js';
import { formatFundamentalsForLlm } from './portfolio-context.js';
import { getLatestSignalsMap, getLatestSignalsMapsForSymbols } from './portfolio-trigger.js';

const log = child({ component: 'thesis-generator' });

/** System prompt for structured thesis JSON — shared with momentum sleeve entry theses. */
export const THESIS_JSON_SYSTEM_PROMPT = `You are a senior Indian equity research analyst (SEBI-registered RIA mindset).
You produce actionable, concise investment theses for NSE/BSE stocks.

CONTEXT:
- These ideas are for NEW watchlist opportunities — symbols the reader does NOT already hold.
  Existing holdings are reviewed separately under My Portfolio.

RULES:
1. Base your thesis ONLY on the data provided — do not hallucinate financials.
2. Keep thesis under 200 words. Be specific about catalysts and risks.
3. entryZone, stopLoss, target must be price ranges in INR (e.g. "₹2,400–₹2,450").
4. confidenceScore: Use the FULL 1–10 range (do not cluster around 5–6).
   - 3–4: mostly technical / weak fundamentals or noisy setup.
   - 7–8: strong alignment between technicals and fundamentals or clear catalyst path.
   - 9–10: reserved for exceptional multi-signal, high-conviction setups only.
5. timeHorizon: "short" (1-4 weeks), "medium" (1-3 months), "long" (3-12 months).
6. triggerScreen: describe what signal/pattern triggered this analysis.
7. Always provide at least 1 bull case and 1 bear case.

RUBRIC (optional but strongly encouraged): Score each qualitative dimension 0-10
using ONLY the provided context. If the context contains no evidence for a
dimension, score it 4 (neutral) and say so.
  - moat: pricing power + switching costs + gaining share, evidenced in provided data
    9-10 = "pricing power + switching costs + gaining share, evidenced in provided data"
    7-8 = "recognisable brand with some pricing power, but switching costs or moat width unverified"
    4-6 = "average industry position; no clear moat visible"
    0-3 = "commoditised, no differentiation visible in data"
  - sectorTailwind: regulatory / demand / macro tailwind for the sector
    9-10 = "strong structural tailwinds (govt policy, demand shift, supply constraints)"
    7-8 = "sector in a cyclical upswing, supportive macros"
    4-6 = "sector outlook neutral or mixed"
    0-3 = "sector headwinds visible (regulatory, demand decline, overcapacity)"
  - competitivePosition: market share, leadership vs peers
    9-10 = "dominant market share with expanding lead"
    7-8 = "top-3 position, holding or slowly gaining share"
    4-6 = "competitive position average, not gaining or losing material share"
    0-3 = "losing share to competitors, weak pricing power"
  - newsCatalyst: recent news / events that act as a catalyst
    9-10 = "company-specific positive catalyst confirmed (order win, regulatory approval, strong guidance)"
    7-8 = "positive sector/peer news that indirectly benefits"
    4-6 = "no material catalyst in recent news / neutral news flow"
    0-3 = "negative news flow (profit warning, investigation, downgrade)"

Return ONLY a single JSON object matching this schema:
{
  "symbol": string,
  "thesis": string (min 20 chars),
  "bullCase": [string, ...] (1-5 items),
  "bearCase": [string, ...] (1-5 items),
  "entryZone": string,
  "stopLoss": string,
  "target": string,
  "timeHorizon": "short" | "medium" | "long",
  "confidenceScore": number (1-10),
  "triggerScreen": string
}

No markdown, no code fences, no commentary. ONLY the JSON object.`;

/** Appended to {@link THESIS_JSON_SYSTEM_PROMPT} when `buildStockContext` includes a momentum snapshot. */
const MOMENTUM_THESIS_ADDENDUM = `MOMENTUM CONTEXT (only when the user message contains "## Momentum factor snapshot"):
- Give a short factor-by-factor read: 12-1 price momentum, fundamentals/EPS growth vs peers (from fundamentals row), relative strength vs benchmark, and breakout/volume where values exist.
- If the snapshot includes **FALSE MOMENTUM WARNING** (mom_false_flag = 1), call that out prominently and keep confidenceScore **≤ 5**.
- Treat numeric momentum fields as authoritative; do not contradict them without explicit justification in bearCase.`;

const QUALITY_GARP_THESIS_ADDENDUM = `QUALITY-GARP CONTEXT (only when the user message contains "## Quality-GARP context"):
- Identify the company's sustainable moat and explain what keeps ROE/margins durable.
- Compare ROE and revenue growth versus sector peers using the supplied sector context.
- If a PEG valuation context line is present, explicitly assess whether PEG is justified versus growth durability.
- If a momentum false-flag warning line is present, weight bearCase accordingly and keep confidenceScore ≤ 5.
- Confidence calibration must stay aligned with guardrails: strong technical + fundamentals in 7-8 band; pure technical and weak fundamentals in 3-4 band.`;

const CATALYST_ENTRY_THESIS_ADDENDUM = `CATALYST ENTRY CONTEXT (only when the user message contains "=== CATALYST EVENT CONTEXT ==="):
- Maximum confidenceScore is 6/10; no analyst estimate revision feed is available, so never infer consensus revisions from price action alone.
- Your thesis must include exactly 2 sentences: (1) what the market likely expects from this earnings event based on recent news tone, (2) whether setup is consensus or contrarian.
- Use stopLoss = entry × 0.96 and target = entry × 1.08.
- Use timeHorizon = "short".
- Set triggerScreen to "catalyst_entry".`;

const MOMENTUM_CONTEXT_GATE_NAMES = new Set(['mom_rank', 'mom_composite_score', 'mom_12_1_return']);

/**
 * Latest-session momentum fields for LLM context (when ranker/signals have run).
 * Returns null when no momentum snapshot exists for this symbol on or before `date`.
 */
export function buildMomentumContextAppend(
  symbol: string,
  date: string,
  db: DatabaseType,
): string | null {
  const snap = getLatestSignalsMap(symbol, date, db);
  const m = new Map<string, number>();
  for (const [k, v] of Object.entries(snap)) {
    if (k.startsWith('mom_')) m.set(k, v);
  }

  if (m.size === 0) return null;
  const hasGate = [...MOMENTUM_CONTEXT_GATE_NAMES].some((k) => m.has(k));
  if (!hasGate) return null;

  const lines: string[] = [
    '\n## Momentum factor snapshot (multi-factor ranker)',
    'Interpret alongside technical signals above. Factor 2 (EPS) uses `profit_growth_yoy` from fundamentals when present.',
  ];
  const pick = (name: string, label: string): void => {
    const v = m.get(name);
    if (v != null && Number.isFinite(v)) lines.push(`- ${label}: ${v}`);
  };
  pick('mom_rank', 'Composite rank (1 = strongest in universe)');
  pick('mom_composite_score', 'Composite score (winsorised z-mix)');
  pick('mom_12_1_return', 'Factor 1: 12-1 price momentum %');
  pick('mom_relative_strength_ba', 'Factor 3: relative strength vs benchmark');
  pick('mom_volume_breakout_flag', 'Factor 4: volume breakout flag');
  pick('mom_earnings_blackout', 'Earnings blackout window (1 = block new entries)');
  pick('mom_rank_excluded', 'Excluded from rank (1 = cold-start / missing factor 1)');
  const ff = m.get('mom_false_flag');
  if (ff === 1) {
    lines.push(
      '\n**FALSE MOMENTUM WARNING:** `mom_false_flag` = 1 (strong price momentum vs weak EPS growth in cross-section). **confidenceScore must be ≤ 5.**',
    );
  } else if (ff != null && Number.isFinite(ff)) {
    lines.push(`\nmom_false_flag: ${ff} (0 = no false-momentum tag)`);
  }

  return lines.join('\n');
}

export function hasMomentumThesisContext(symbol: string, date: string, db: DatabaseType): boolean {
  return buildMomentumContextAppend(symbol, date, db) != null;
}

interface QualityGarpThesisContext {
  peg: number | null;
  sector: string | null;
  falseMomentumFlag: boolean;
}

interface CatalystEntryThesisContext {
  expectedEarningsDate: string;
  daysToEarnings: number;
  pctFromSma50: number;
  pctFrom52wLow: number | null;
  profitGrowthYoY: number | null;
  recentSentimentAvg: number | null;
  recentNewsCount: number;
  headlines: string[];
}

function getQualityGarpThesisContext(
  symbol: string,
  date: string,
  db: DatabaseType,
): QualityGarpThesisContext | null {
  const row = db
    .prepare(
      `
      SELECT matched_criteria AS matchedCriteria
      FROM screens
      WHERE symbol = ? AND date = ? AND screen_name = 'quality_garp'
      LIMIT 1
    `,
    )
    .get(symbol, date) as { matchedCriteria: string } | undefined;
  if (!row) return null;

  let peg: number | null = null;
  try {
    const parsed = JSON.parse(row.matchedCriteria) as Record<string, unknown>;
    const rawPeg = parsed.peg;
    peg = typeof rawPeg === 'number' && Number.isFinite(rawPeg) ? rawPeg : null;
  } catch {
    peg = null;
  }

  const sectorRow = db.prepare('SELECT sector FROM symbols WHERE symbol = ?').get(symbol) as
    | { sector: string | null }
    | undefined;

  const signalSnap = getLatestSignalsMap(symbol, date, db);
  return {
    peg,
    sector: sectorRow?.sector ?? null,
    falseMomentumFlag: signalSnap.mom_false_flag === 1,
  };
}

function buildQualityGarpContextAppend(
  symbol: string,
  date: string,
  db: DatabaseType,
): string | null {
  const ctx = getQualityGarpThesisContext(symbol, date, db);
  if (!ctx) return null;

  const lines = ['\n## Quality-GARP context'];
  lines.push('- Screen trigger: quality_garp');
  if (ctx.sector) {
    lines.push(`- Sector context: ${ctx.sector}`);
  } else {
    lines.push('- Sector context: unknown (sector missing in symbols table)');
  }
  lines.push(
    '- Compare this company against sector peers on ROE durability and revenue-growth quality before forming conviction.',
  );
  lines.push('- Identify the sustainable moat supporting margins/returns.');
  if (ctx.peg != null) {
    lines.push(
      `- Valuation context: current PEG ratio is ${ctx.peg}. Assess whether this is justified given the growth rate.`,
    );
  }
  if (ctx.falseMomentumFlag) {
    lines.push(
      '- Warning: momentum false flag is set (high price momentum with negative profit growth). Weight bear case accordingly.',
    );
  }
  return lines.join('\n');
}

function getCatalystEntryThesisContext(
  symbol: string,
  date: string,
  db: DatabaseType,
): CatalystEntryThesisContext | null {
  const row = db
    .prepare(
      `
      SELECT matched_criteria AS matchedCriteria
      FROM screens
      WHERE symbol = ? AND date = ? AND screen_name = 'catalyst_entry'
      LIMIT 1
    `,
    )
    .get(symbol, date) as { matchedCriteria: string } | undefined;
  if (!row) return null;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(row.matchedCriteria) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed) return null;

  const expectedEarningsDate = parsed.expected_earnings_date;
  const daysToEarnings = parsed.days_to_earnings;
  const pctFromSma50 = parsed.pct_from_sma50;
  if (
    typeof expectedEarningsDate !== 'string' ||
    typeof daysToEarnings !== 'number' ||
    typeof pctFromSma50 !== 'number'
  ) {
    return null;
  }

  const pctFrom52wLow =
    typeof parsed.pct_from_52w_low === 'number' && Number.isFinite(parsed.pct_from_52w_low)
      ? parsed.pct_from_52w_low
      : null;
  const profitGrowthYoY =
    typeof parsed.profit_growth_yoy === 'number' && Number.isFinite(parsed.profit_growth_yoy)
      ? parsed.profit_growth_yoy
      : null;
  const recentSentimentAvg =
    typeof parsed.recent_sentiment_avg === 'number' && Number.isFinite(parsed.recent_sentiment_avg)
      ? parsed.recent_sentiment_avg
      : null;
  const recentNewsCount =
    typeof parsed.recent_news_count === 'number' && Number.isFinite(parsed.recent_news_count)
      ? parsed.recent_news_count
      : 0;

  const headlines = (
    db
      .prepare(
        `
      SELECT headline
      FROM news
      WHERE symbol = ?
        AND published_at >= datetime(?, '-7 days')
      ORDER BY published_at DESC
      LIMIT 2
    `,
      )
      .all(symbol, date) as Array<{ headline: string }>
  ).map((h) => h.headline);

  return {
    expectedEarningsDate,
    daysToEarnings,
    pctFromSma50,
    pctFrom52wLow,
    profitGrowthYoY,
    recentSentimentAvg,
    recentNewsCount,
    headlines,
  };
}

function buildCatalystEntryContextAppend(
  symbol: string,
  date: string,
  db: DatabaseType,
): string | null {
  const ctx = getCatalystEntryThesisContext(symbol, date, db);
  if (!ctx) return null;

  const lines = [
    '\n=== CATALYST EVENT CONTEXT ===',
    `Earnings date: ${ctx.expectedEarningsDate} (${ctx.daysToEarnings} days away)`,
    `Price vs SMA50: ${ctx.pctFromSma50}%`,
    `Distance from 52W low: ${ctx.pctFrom52wLow ?? 'unavailable'}%`,
    `Profit growth YoY: ${ctx.profitGrowthYoY ?? 'unavailable'}%`,
    `Recent news (${ctx.recentNewsCount} items in last 7 days):`,
    `  Avg sentiment: ${ctx.recentSentimentAvg ?? 'no recent news'}`,
  ];
  if (ctx.headlines.length === 0) {
    lines.push('  Headlines: unavailable');
  } else {
    lines.push(`  Headlines: ${ctx.headlines.join(' | ')}`);
  }
  return lines.join('\n');
}

export interface ThesisGeneratorOptions {
  /** ISO date (YYYY-MM-DD). Defaults to today IST. */
  date?: string;
  /** Watchlist to generate theses for. Defaults to configured watchlist. */
  watchlist?: string[];
  /** Maximum number of thesis cards to generate. Defaults to config value. */
  maxTheses?: number;
  /** When set, skips thesis generation if `ai_picks_generation` is disallowed for this regime. */
  regime?: Regime;
}

export interface ThesisGeneratorResult {
  date: string;
  generated: number;
  failed: number;
  /** Candidates with score > 0 after ranking (before max-thesis cap). */
  candidateCount: number;
  /** Candidate pool minus holdings and OPEN paper trades. */
  eligibleUniverseSize: number;
  /** Watchlist symbol count (screen hits may extend the candidate pool beyond this). */
  watchlistSize: number;
  /** AI-generated thesis rows from this run (may be empty when gated or no candidates). */
  theses: StoredThesis[];
}

/** Screen hits for the session plus watchlist — pool before already-owned filters. */
export function resolveThesisCandidatePool(
  date: string,
  watchlist: string[],
  db: DatabaseType,
): string[] {
  const set = new Set<string>();
  for (const s of watchlist) set.add(s.toUpperCase());
  const rows = db.prepare('SELECT DISTINCT symbol FROM screens WHERE date = ?').all(date) as Array<{
    symbol: string;
  }>;
  for (const r of rows) set.add(r.symbol.toUpperCase());
  return [...set];
}

/** Symbols eligible for AI Picks: candidate pool minus holdings and OPEN paper trades. */
export function resolveThesisEligibleUniverse(
  date: string,
  watchlist: string[],
  db: DatabaseType,
): string[] {
  const holdingSet = new Set(getLatestHoldings(db).map((h) => h.symbol.toUpperCase()));
  const openPaperSet = new Set(getDistinctOpenPaperTradeSymbols(db));
  return resolveThesisCandidatePool(date, watchlist, db).filter((s) => {
    if (holdingSet.has(s)) return false;
    if (openPaperSet.has(s)) {
      log.debug({ symbol: s }, 'Skipping AI Thesis: Symbol already has an OPEN paper trade.');
      return false;
    }
    return true;
  });
}

export async function generateTheses(
  opts: ThesisGeneratorOptions = {},
  db: DatabaseType = getDb(),
  llm: LlmProvider = getLlmProvider(),
): Promise<ThesisGeneratorResult> {
  const date = opts.date ?? isoDateIst();
  const watchlist = (opts.watchlist ?? loadWatchlist().symbols).map((s) => s.toUpperCase());
  const universe = resolveThesisEligibleUniverse(date, watchlist, db);
  const maxTheses = opts.maxTheses ?? config.THESIS_MAX_PER_RUN;

  if (opts.regime != null && !isStrategyAllowed('ai_picks_generation', opts.regime, db)) {
    log.info({ regime: opts.regime }, '[GATED] ai_picks_generation — skipping thesis generation');
    return {
      date,
      generated: 0,
      failed: 0,
      candidateCount: 0,
      eligibleUniverseSize: universe.length,
      watchlistSize: watchlist.length,
      theses: [],
    };
  }

  const candidates = rankCandidates(date, universe, db);
  const toGenerate = candidates.slice(0, maxTheses);

  if (toGenerate.length === 0) {
    log.info(
      {
        universe: universe.length,
        watchlist: watchlist.length,
        ranked: candidates.length,
      },
      'no candidates with interesting signals for thesis generation',
    );
    return {
      date,
      generated: 0,
      failed: 0,
      candidateCount: candidates.length,
      eligibleUniverseSize: universe.length,
      watchlistSize: watchlist.length,
      theses: [],
    };
  }

  log.info(
    {
      count: toGenerate.length,
      concurrency: config.THESIS_CONCURRENCY,
    },
    'thesis generation starting',
  );

  const limit = pLimit(config.THESIS_CONCURRENCY);
  const results = await Promise.all(
    toGenerate.map((candidate) =>
      limit(async () => {
        try {
          const context = buildStockContext(candidate.symbol, date, db);
          const momentumContext = hasMomentumThesisContext(candidate.symbol, date, db);
          const qualityGarpContext = buildQualityGarpContextAppend(candidate.symbol, date, db);
          const catalystContext = buildCatalystEntryContextAppend(candidate.symbol, date, db);
          const contextWithScreen = [context, qualityGarpContext, catalystContext]
            .filter((part): part is string => part != null && part !== '')
            .join('\n');
          const systemAddenda: string[] = [];
          if (momentumContext) systemAddenda.push(MOMENTUM_THESIS_ADDENDUM);
          if (qualityGarpContext) systemAddenda.push(QUALITY_GARP_THESIS_ADDENDUM);
          if (catalystContext) systemAddenda.push(CATALYST_ENTRY_THESIS_ADDENDUM);
          const system =
            systemAddenda.length > 0
              ? `${THESIS_JSON_SYSTEM_PROMPT}\n\n${systemAddenda.join('\n\n')}`
              : THESIS_JSON_SYSTEM_PROMPT;
          const result = await llm.generateJson<Thesis>({
            system,
            user: contextWithScreen,
            schema: ThesisSchema,
            temperature: 0.3,
            maxRetries: 2,
          });

          const signalSnap = getLatestSignalsMap(candidate.symbol, date, db);
          let thesisOut = result.data;
          if (signalSnap.mom_false_flag === 1) {
            thesisOut = {
              ...thesisOut,
              confidenceScore: Math.min(thesisOut.confidenceScore, 5),
            };
          }
          if (catalystContext) {
            thesisOut = {
              ...thesisOut,
              confidenceScore: Math.min(thesisOut.confidenceScore, 6),
            };
          }

          const anchors = computeRubricAnchors(candidate.symbol, date, db);
          const rubricTotal = computeRubricTotal(anchors, thesisOut.rubric ?? null);
          const rubricJson = JSON.stringify({
            anchors,
            llm: thesisOut.rubric ?? null,
            total: rubricTotal,
          });

          const row: UpsertThesisRow = {
            ...thesisOut,
            symbol: candidate.symbol,
            date,
            model: result.model,
            raw: result.raw,
            rubricJson,
          };
          upsertThesis(row, db);

          log.info(
            {
              symbol: candidate.symbol,
              confidence: thesisOut.confidenceScore,
              model: result.model,
            },
            'thesis generated',
          );
          return { ok: true as const };
        } catch (err) {
          log.warn(
            { symbol: candidate.symbol, err: (err as Error).message },
            'thesis generation failed',
          );
          return { ok: false as const };
        }
      }),
    ),
  );

  let generated = 0;
  let failed = 0;
  for (const r of results) {
    if (r.ok) generated++;
    else failed++;
  }

  const theses = getThesesForDate(date, db);
  log.info(
    { generated, failed, total: theses.length, candidateCount: candidates.length },
    'thesis generation complete',
  );

  return {
    date,
    generated,
    failed,
    candidateCount: candidates.length,
    eligibleUniverseSize: universe.length,
    watchlistSize: watchlist.length,
    theses,
  };
}

// ---------------------------------------------------------------------------
// Candidate ranking — picks the most "interesting" stocks
// ---------------------------------------------------------------------------

interface Candidate {
  symbol: string;
  interestScore: number;
  signals: Record<string, number>;
  reasons: string[];
}

/**
 * Ordered thesis-interest ranking for the eligible AI Picks universe.
 * Used by `generateTheses` and the briefing “why ranked #N” line.
 */
export function getThesisRankMeta(
  date: string,
  universe: string[],
  db: DatabaseType,
): Map<string, { rank: number; reasonsLine: string }> {
  const ranked = rankCandidates(date, universe, db);
  const map = new Map<string, { rank: number; reasonsLine: string }>();
  ranked.forEach((c, i) => {
    map.set(c.symbol, {
      rank: i + 1,
      reasonsLine: c.reasons.length > 0 ? c.reasons.join(' · ') : 'Interesting signals',
    });
  });
  return map;
}

function rankCandidates(date: string, universe: string[], db: DatabaseType): Candidate[] {
  if (universe.length === 0) return [];

  const bySymbol = getLatestSignalsMapsForSymbols(universe, date, db);

  const screenSyms = new Set(
    (
      db.prepare('SELECT DISTINCT symbol FROM screens WHERE date = ?').all(date) as Array<{
        symbol: string;
      }>
    ).map((r) => r.symbol.toUpperCase()),
  );
  const alertSyms = new Set(
    (
      db.prepare('SELECT DISTINCT symbol FROM alerts WHERE date = ?').all(date) as Array<{
        symbol: string;
      }>
    ).map((r) => r.symbol.toUpperCase()),
  );

  const candidates: Candidate[] = [];
  for (const symbol of universe) {
    const signals = bySymbol.get(symbol) ?? {};
    let score = 0;
    const reasons: string[] = [];

    const rsi = signals.rsi_14;
    if (rsi != null) {
      if (rsi >= 70 || rsi <= 30) {
        score += 3;
        reasons.push(rsi >= 70 ? 'RSI stretched (high)' : 'RSI stretched (low)');
      } else if (rsi >= 60 || rsi <= 40) {
        score += 1;
        reasons.push('RSI elevated');
      }
    }
    const volRatio = signals.volume_ratio_20d;
    if (volRatio != null) {
      if (volRatio >= 1.5) {
        score += 2;
        reasons.push('Volume vs 20d elevated');
      } else if (volRatio >= 1.2) {
        score += 1;
        reasons.push('Volume uptick');
      }
    }
    const pctHigh = signals.pct_from_52w_high;
    if (pctHigh != null && pctHigh >= -3) {
      score += 2;
      reasons.push('Near 52W high');
    }
    const pctLow = signals.pct_from_52w_low;
    if (pctLow != null && pctLow <= 5) {
      score += 2;
      reasons.push('Near 52W low');
    }

    if (screenSyms.has(symbol)) {
      score += 6;
      reasons.push('Screen match today');
    }
    if (alertSyms.has(symbol)) {
      score += 5;
      reasons.push('Watchlist alert today');
    }

    if (score > 0) {
      candidates.push({ symbol, interestScore: score, signals, reasons });
    }
  }

  candidates.sort((a, b) => {
    const d = b.interestScore - a.interestScore;
    if (d !== 0) return d;
    return a.symbol.localeCompare(b.symbol);
  });
  return candidates;
}

// ---------------------------------------------------------------------------
// External signal holdings context (thesis user message only; table optional)
// ---------------------------------------------------------------------------

/** Display-name cache for ext-signal config; stable for one Node process / daily run. */
let extSignalConfigCache: ExtSignalProviderFile | null = null;

function loadExtSignalConfig(): ExtSignalProviderFile {
  if (extSignalConfigCache) return extSignalConfigCache;
  extSignalConfigCache = loadExtSignalProvider();
  return extSignalConfigCache;
}

/** Tests only — separate from the loaders config cache. */
export function resetExtSignalConfigCacheForTests(): void {
  extSignalConfigCache = null;
}

function getExtSignalContext(db: DatabaseType, symbol: string, asOf: string): string | null {
  try {
    const rows = db
      .prepare(
        `
      SELECT strategy_name, weight_pct
      FROM ext_signal_holdings
      WHERE symbol = ? AND as_of = ?
    `,
      )
      .all(symbol, asOf) as Array<{ strategy_name: string; weight_pct: number }>;

    if (rows.length === 0) return null;

    const config = loadExtSignalConfig();
    const lines = rows.map((r) => {
      const strat = config.strategies.find((s) => s.name === r.strategy_name);
      const label = strat?.display_name ?? r.strategy_name;
      return `${label} (${r.weight_pct.toFixed(1)}% weight)`;
    });

    return [
      '## External signal (corroborating only)',
      `This symbol appears in the following external model portfolios as of ${asOf}: ${lines.join(', ')}.`,
      'Treat as weak corroboration only — not a primary thesis input.',
      'Do not reference or name the signal source in the thesis output.',
    ].join('\n');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Context builder — assembles everything the LLM needs for a single stock
// ---------------------------------------------------------------------------

export type StockContextVariant = 'thesis' | 'portfolio';

/**
 * Assembles LLM-readable context for one symbol.
 * - `thesis`: includes broad news (symbol + untagged) and FII/DII flows.
 * - `portfolio`: stock-specific news only; omits FII/DII (macro belongs in Market Mood).
 */
export function buildStockContext(
  symbol: string,
  date: string,
  db: DatabaseType,
  variant: StockContextVariant = 'thesis',
): string {
  const sections: string[] = [`Analyse ${symbol} as of ${date}.\n`];

  const quotes = db
    .prepare(`
      SELECT date, open, high, low, close, volume FROM quotes
      WHERE symbol = ? AND date <= ?
      ORDER BY date DESC LIMIT 20
    `)
    .all(symbol, date) as Array<{
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;

  if (quotes.length > 0) {
    sections.push('## Recent Price Action (last 20 trading days, newest first)');
    sections.push('Date | Open | High | Low | Close | Volume');
    for (const q of quotes) {
      sections.push(
        `${q.date} | ${q.open.toFixed(2)} | ${q.high.toFixed(2)} | ${q.low.toFixed(2)} | ${q.close.toFixed(2)} | ${q.volume}`,
      );
    }
  }

  const signalMap = getLatestSignalsMap(symbol, date, db);
  const techLines = Object.entries(signalMap)
    .filter(([name]) => !name.startsWith('mom_'))
    .sort(([a], [b]) => a.localeCompare(b));

  if (techLines.length > 0) {
    sections.push('\n## Technical Signals');
    for (const [name, value] of techLines) {
      sections.push(`${name}: ${value.toFixed(4)}`);
    }
  }

  const fundamentals = db
    .prepare(`
      SELECT * FROM fundamentals
      WHERE symbol = ?
      ORDER BY as_of DESC LIMIT 1
    `)
    .get(symbol) as Record<string, unknown> | undefined;

  if (fundamentals) {
    sections.push('\n## Fundamentals');
    for (const line of formatFundamentalsForLlm(fundamentals)) {
      sections.push(line);
    }
  }

  const momentumCtx = buildMomentumContextAppend(symbol, date, db);
  if (momentumCtx) sections.push(momentumCtx);

  const news =
    variant === 'portfolio'
      ? (db
          .prepare(
            `
      SELECT headline, source, published_at, sentiment FROM news
      WHERE symbol = ?
        AND published_at >= datetime(?, '-7 days')
      ORDER BY published_at DESC LIMIT 10
    `,
          )
          .all(symbol, date) as Array<{
          headline: string;
          source: string;
          published_at: string;
          sentiment: number | null;
        }>)
      : (db
          .prepare(
            `
      SELECT headline, source, published_at, sentiment FROM news
      WHERE (symbol = ? OR symbol IS NULL)
        AND published_at >= datetime(?, '-7 days')
      ORDER BY published_at DESC LIMIT 10
    `,
          )
          .all(symbol, date) as Array<{
          headline: string;
          source: string;
          published_at: string;
          sentiment: number | null;
        }>);

  if (news.length > 0) {
    sections.push(
      variant === 'portfolio'
        ? '\n## Recent News (symbol-tagged only, last 7 days)'
        : '\n## Recent News (last 7 days)',
    );
    for (const n of news) {
      const sent = n.sentiment != null ? ` [sentiment: ${n.sentiment.toFixed(2)}]` : '';
      sections.push(`- ${n.headline} (${n.source}, ${n.published_at})${sent}`);
    }
  } else if (variant === 'portfolio') {
    sections.push('\n## Recent News (symbol-tagged only, last 7 days)');
    sections.push('- No symbol-tagged headlines in the window — do not invent company news.');
  }

  if (variant === 'thesis') {
    const fiiDii = db
      .prepare(
        `
      SELECT date, segment, fii_net, dii_net FROM fii_dii
      WHERE date <= ? ORDER BY date DESC LIMIT 5
    `,
      )
      .all(date) as Array<{
      date: string;
      segment: string;
      fii_net: number;
      dii_net: number;
    }>;

    if (fiiDii.length > 0) {
      sections.push('\n## FII/DII Activity (recent)');
      for (const f of fiiDii) {
        sections.push(
          `${f.date} ${f.segment}: FII net ₹${f.fii_net.toFixed(0)}Cr, DII net ₹${f.dii_net.toFixed(0)}Cr`,
        );
      }
    }

    const extCtx = getExtSignalContext(db, symbol, date);
    if (extCtx) sections.push(`\n${extCtx}`);

    // Concall intelligence context (Task B) — advisory only, never gates anything
    const concallIntel = getLatestConcallIntel(symbol, date, db);
    if (concallIntel) {
      sections.push('\n## Latest concall intelligence');
      sections.push(`Sentiment: ${concallIntel.sentiment} · Credibility: ${concallIntel.credibilityStars}/5`);
      sections.push(`Summary: ${concallIntel.summary}`);
      try {
        const guidance = JSON.parse(concallIntel.guidanceJson) as Array<{
          metric: string;
          value: string;
          horizon: string;
          verbatim: string;
        }>;
        const top3 = guidance.slice(0, 3);
        if (top3.length > 0) {
          sections.push('Top guidance items:');
          for (const g of top3) {
            sections.push(`- ${g.metric}: ${g.value} (${g.horizon}) — "${g.verbatim}"`);
          }
        }
      } catch {
        // guidance_json parse failure — skip
      }
    }
  }

  return sections.join('\n');
}
