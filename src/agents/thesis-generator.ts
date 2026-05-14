/**
 * Thesis generator agent. For each stock in the watchlist that has "interesting"
 * signals, assembles a data context (quotes, fundamentals, signals, recent news)
 * and asks the LLM to produce a structured Thesis.
 *
 * The output is persisted to the `theses` table and surfaced in the briefing.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { config } from '../config/env.js';
import { loadWatchlist } from '../config/loaders.js';
import { getDb, getLatestHoldings, isStrategyAllowed } from '../db/index.js';
import {
  type StoredThesis,
  type UpsertThesisRow,
  getDistinctOpenPaperTradeSymbols,
  getThesesForDate,
  upsertThesis,
} from '../db/queries.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { getLlmProvider } from '../llm/index.js';
import type { LlmProvider } from '../llm/types.js';
import { child } from '../logger.js';
import { type Thesis, ThesisSchema } from '../types/domain.js';
import type { Regime } from '../types/regime.js';
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

export interface ThesisGeneratorOptions {
  date?: string;
  watchlist?: string[];
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
  /** Watchlist symbols excluding current holdings and symbols with any OPEN paper trade. */
  eligibleUniverseSize: number;
  /** Raw watchlist symbol count for messaging when AI Picks is empty. */
  watchlistSize: number;
  /** AI-generated thesis rows from this run (may be empty when gated or no candidates). */
  theses: StoredThesis[];
}

export async function generateTheses(
  opts: ThesisGeneratorOptions = {},
  db: DatabaseType = getDb(),
  llm: LlmProvider = getLlmProvider(),
): Promise<ThesisGeneratorResult> {
  const date = opts.date ?? isoDateIst();
  const watchlist = (opts.watchlist ?? loadWatchlist().symbols).map((s) => s.toUpperCase());
  const holdingsUpper = getLatestHoldings(db).map((h) => h.symbol.toUpperCase());
  const openPaperSymbolsUpper = getDistinctOpenPaperTradeSymbols(db);
  const holdingSet = new Set(holdingsUpper);
  const openPaperSet = new Set(openPaperSymbolsUpper);
  /** AI Picks: watchlist names not in live portfolio and not already tracked as an OPEN paper trade. */
  const universe = watchlist.filter((s) => {
    if (holdingSet.has(s)) return false;
    if (openPaperSet.has(s)) {
      log.debug({ symbol: s }, 'Skipping AI Thesis: Symbol already has an OPEN paper trade.');
      return false;
    }
    return true;
  });
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

  log.info({ candidates: toGenerate.map((c) => c.symbol) }, 'generating theses for top candidates');

  let generated = 0;
  let failed = 0;

  for (const candidate of toGenerate) {
    try {
      const context = buildStockContext(candidate.symbol, date, db);
      const system = hasMomentumThesisContext(candidate.symbol, date, db)
        ? `${THESIS_JSON_SYSTEM_PROMPT}\n\n${MOMENTUM_THESIS_ADDENDUM}`
        : THESIS_JSON_SYSTEM_PROMPT;
      const result = await llm.generateJson<Thesis>({
        system,
        user: context,
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

      const row: UpsertThesisRow = {
        ...thesisOut,
        symbol: candidate.symbol,
        date,
        model: result.model,
        raw: result.raw,
      };
      upsertThesis(row, db);
      generated++;

      log.info(
        { symbol: candidate.symbol, confidence: thesisOut.confidenceScore, model: result.model },
        'thesis generated',
      );
    } catch (err) {
      failed++;
      log.warn(
        { symbol: candidate.symbol, err: (err as Error).message },
        'thesis generation failed',
      );
    }
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
 * Ordered thesis-interest ranking for the thesis universe (typically watchlist ∩ ¬holdings).
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
    for (const [k, v] of Object.entries(fundamentals)) {
      if (v != null && k !== 'symbol' && k !== 'ingested_at' && k !== 'source') {
        sections.push(`${k}: ${v}`);
      }
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
  }

  return sections.join('\n');
}
