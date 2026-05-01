/**
 * Thesis generator agent. For each stock in the watchlist that has "interesting"
 * signals, assembles a data context (quotes, fundamentals, signals, recent news)
 * and asks the LLM to produce a structured Thesis.
 *
 * The output is persisted to the `theses` table and surfaced in the briefing.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { loadWatchlist } from '../config/loaders.js';
import { getDb, getLatestHoldings } from '../db/index.js';
import {
  type StoredThesis,
  type UpsertThesisRow,
  getThesesForDate,
  upsertThesis,
} from '../db/queries.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { getLlmProvider } from '../llm/index.js';
import type { LlmProvider } from '../llm/types.js';
import { child } from '../logger.js';
import { type Thesis, ThesisSchema } from '../types/domain.js';

const log = child({ component: 'thesis-generator' });

const MAX_THESES_PER_RUN = 5;

const SYSTEM_PROMPT = `You are a senior Indian equity research analyst (SEBI-registered RIA mindset).
You produce actionable, concise investment theses for NSE/BSE stocks.

RULES:
1. Base your thesis ONLY on the data provided — do not hallucinate financials.
2. Keep thesis under 200 words. Be specific about catalysts and risks.
3. entryZone, stopLoss, target must be price ranges in INR (e.g. "₹2,400–₹2,450").
4. confidenceScore: 1=speculative, 5=moderate conviction, 10=highest conviction.
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

export interface ThesisGeneratorOptions {
  date?: string;
  watchlist?: string[];
  maxTheses?: number;
}

export interface ThesisGeneratorResult {
  date: string;
  generated: number;
  failed: number;
  /** Watchlist + holdings considered “interesting” before the max-thesis cap. */
  candidateCount: number;
  theses: StoredThesis[];
}

export async function generateTheses(
  opts: ThesisGeneratorOptions = {},
  db: DatabaseType = getDb(),
  llm: LlmProvider = getLlmProvider(),
): Promise<ThesisGeneratorResult> {
  const date = opts.date ?? isoDateIst();
  const watchlist = (opts.watchlist ?? loadWatchlist().symbols).map((s) => s.toUpperCase());
  const holdings = getLatestHoldings(db).map((h) => h.symbol.toUpperCase());
  const universe = [...new Set([...watchlist, ...holdings])];
  const maxTheses = opts.maxTheses ?? MAX_THESES_PER_RUN;

  const candidates = rankCandidates(date, universe, db);
  const toGenerate = candidates.slice(0, maxTheses);

  if (toGenerate.length === 0) {
    log.info(
      { universe: universe.length, ranked: candidates.length },
      'no candidates with interesting signals for thesis generation',
    );
    return { date, generated: 0, failed: 0, candidateCount: candidates.length, theses: [] };
  }

  log.info({ candidates: toGenerate.map((c) => c.symbol) }, 'generating theses for top candidates');

  let generated = 0;
  let failed = 0;

  for (const candidate of toGenerate) {
    try {
      const context = buildStockContext(candidate.symbol, date, db);
      const result = await llm.generateJson<Thesis>({
        system: SYSTEM_PROMPT,
        user: context,
        schema: ThesisSchema,
        temperature: 0.3,
        maxRetries: 2,
      });

      const row: UpsertThesisRow = {
        ...result.data,
        symbol: candidate.symbol,
        date,
        model: result.model,
        raw: result.raw,
      };
      upsertThesis(row, db);
      generated++;

      log.info(
        { symbol: candidate.symbol, confidence: result.data.confidenceScore, model: result.model },
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

  return { date, generated, failed, candidateCount: candidates.length, theses };
}

// ---------------------------------------------------------------------------
// Candidate ranking — picks the most "interesting" stocks
// ---------------------------------------------------------------------------

interface Candidate {
  symbol: string;
  interestScore: number;
  signals: Record<string, number>;
}

/** Holdings at or below this unrealised P&amp;L % are forced into the candidate pool. */
const PORTFOLIO_THESIS_LOSS_PCT = -15;

function rankCandidates(date: string, universe: string[], db: DatabaseType): Candidate[] {
  if (universe.length === 0) return [];

  const placeholders = universe.map(() => '?').join(',');
  const rows = db
    .prepare(`
      SELECT symbol, name, value FROM signals
      WHERE date <= ? AND symbol IN (${placeholders})
        AND date = (
          SELECT MAX(date) FROM signals s2
          WHERE s2.symbol = signals.symbol AND s2.date <= ?
        )
    `)
    .all(date, ...universe, date) as Array<{ symbol: string; name: string; value: number }>;

  const bySymbol = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const signals = bySymbol.get(r.symbol) ?? {};
    signals[r.name] = r.value;
    bySymbol.set(r.symbol, signals);
  }

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
  const deepLossSyms = new Set(
    getLatestHoldings(db)
      .filter((h) => h.pnlPct != null && h.pnlPct <= PORTFOLIO_THESIS_LOSS_PCT)
      .map((h) => h.symbol.toUpperCase()),
  );

  const candidates: Candidate[] = [];
  for (const symbol of universe) {
    const signals = bySymbol.get(symbol) ?? {};
    let score = 0;

    const rsi = signals.rsi_14;
    if (rsi != null) {
      if (rsi >= 70 || rsi <= 30) score += 3;
      else if (rsi >= 60 || rsi <= 40) score += 1;
    }
    const volRatio = signals.volume_ratio_20d;
    if (volRatio != null) {
      if (volRatio >= 1.5) score += 2;
      else if (volRatio >= 1.2) score += 1;
    }
    const pctHigh = signals.pct_from_52w_high;
    if (pctHigh != null && pctHigh >= -3) score += 2;
    const pctLow = signals.pct_from_52w_low;
    if (pctLow != null && pctLow <= 5) score += 2;

    if (screenSyms.has(symbol)) score += 5;
    if (alertSyms.has(symbol)) score += 4;
    if (deepLossSyms.has(symbol)) score += 6;

    if (score > 0) {
      candidates.push({ symbol, interestScore: score, signals });
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

  const signals = db
    .prepare(`
      SELECT name, value FROM signals
      WHERE symbol = ? AND date <= ?
        AND date = (SELECT MAX(date) FROM signals s2 WHERE s2.symbol = signals.symbol AND s2.date <= ?)
    `)
    .all(symbol, date, date) as Array<{ name: string; value: number }>;

  if (signals.length > 0) {
    sections.push('\n## Technical Signals');
    for (const s of signals) {
      sections.push(`${s.name}: ${s.value.toFixed(4)}`);
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
