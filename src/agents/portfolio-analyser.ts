/**
 * Portfolio Analyser. For every holding in the latest portfolio snapshot,
 * assembles a context (current P&L, technical signals, fundamentals, news,
 * screens fired today, alerts) and asks the LLM for a structured
 * HOLD / ADD / TRIM / EXIT recommendation.
 *
 * Persists per-holding analysis to portfolio_analysis. The briefing
 * surfaces it under a "My Portfolio" section.
 *
 * This is the headline Phase 5 deliverable: it answers the user's literal
 * morning question — "given everything that happened, what should I do
 * with each of my positions today?".
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import pLimit from 'p-limit';
import { z } from 'zod';
import { config } from '../config/env.js';
import {
  type PortfolioAnalysisRow,
  type PortfolioHoldingRow,
  getDb,
  getLatestHoldings,
  upsertPortfolioAnalysis,
} from '../db/index.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { getLlmProvider } from '../llm/index.js';
import type { LlmProvider } from '../llm/types.js';
import { child } from '../logger.js';
import { buildStockContext } from './thesis-generator.js';

const log = child({ component: 'portfolio-analyser' });

const PortfolioActionSchema = z.object({
  symbol: z.string(),
  action: z.enum(['HOLD', 'ADD', 'TRIM', 'EXIT']),
  conviction: z.number().min(0).max(1),
  thesis: z.string().min(20).max(800),
  bullPoints: z.array(z.string().min(1)).min(1).max(5),
  bearPoints: z.array(z.string().min(1)).min(1).max(5),
  triggerReason: z.string().min(5).max(280),
  suggestedStop: z.number().nullable().optional(),
  suggestedTarget: z.number().nullable().optional(),
});
type PortfolioAction = z.infer<typeof PortfolioActionSchema>;

const SYSTEM_PROMPT = `You are a senior Indian-equity portfolio review analyst. The user already
OWNS the position you are analysing. Your job is to recommend ONE of four
actions based ONLY on the data provided:

  HOLD  — keep the position as-is, thesis still intact
  ADD   — accumulate more on the current setup
  TRIM  — book partial profits / reduce exposure
  EXIT  — close the entire position

Rules:
1. Anchor your reasoning on what's CHANGED since entry: P&L vs entry, recent
   technical setup, news flow, fundamentals trajectory.
2. NEVER hallucinate financials. If a data point isn't provided, don't
   invoke it.
3. ADD/TRIM/EXIT recommendations require a concrete catalyst — name it in
   triggerReason.
4. Conviction is 0..1. Below 0.4 → HOLD by default unless there's a strong
   exit signal.
5. suggestedStop / suggestedTarget are optional INR levels (numbers, not
   strings). Omit if not applicable.

Output ONLY a single JSON object matching the schema. No markdown fences,
no commentary, no greetings. Just the JSON.

Schema:
{
  "symbol": string,
  "action": "HOLD" | "ADD" | "TRIM" | "EXIT",
  "conviction": number (0..1),
  "thesis": string (20-800 chars, 2-3 sentences),
  "bullPoints": string[] (1-5 items),
  "bearPoints": string[] (1-5 items),
  "triggerReason": string (one sentence: what changed?),
  "suggestedStop": number | null,
  "suggestedTarget": number | null
}`;

export interface PortfolioAnalyserOptions {
  date?: string;
  /** Restrict analysis to a subset of symbols (default: every holding). */
  symbols?: string[];
  /** Skip holdings whose qty * avgPrice is below this rupee value. */
  minPositionInr?: number;
  /**
   * Max concurrent Vertex / LLM calls. Defaults to PORTFOLIO_ANALYSIS_CONCURRENCY
   * (env). Prior to this knob, every holding ran sequentially — 88 holdings ×
   * ~10s ≈ 15 minutes wall-clock.
   */
  concurrency?: number;
}

export interface PortfolioAnalyserResult {
  date: string;
  analysed: number;
  failed: number;
  byAction: Record<'HOLD' | 'ADD' | 'TRIM' | 'EXIT', number>;
  rows: PortfolioAnalysisRow[];
}

export async function analysePortfolio(
  opts: PortfolioAnalyserOptions = {},
  db: DatabaseType = getDb(),
  llm: LlmProvider = getLlmProvider(),
): Promise<PortfolioAnalyserResult> {
  const date = opts.date ?? isoDateIst();
  const minInr = opts.minPositionInr ?? 0;
  const concurrency = opts.concurrency ?? config.PORTFOLIO_ANALYSIS_CONCURRENCY;

  const allHoldings = getLatestHoldings(db);
  const filtered = allHoldings
    .filter((h) => !opts.symbols || opts.symbols.includes(h.symbol))
    .filter((h) => h.qty * h.avgPrice >= minInr);

  if (filtered.length === 0) {
    log.info({ date }, 'no holdings to analyse — skipping');
    return { date, analysed: 0, failed: 0, byAction: empty(), rows: [] };
  }

  log.info({ date, holdings: filtered.length, concurrency }, 'portfolio analyser starting');

  const limit = pLimit(concurrency);
  const outcomes = await Promise.all(
    filtered.map((h) =>
      limit(async () => {
        try {
          const row = await analyseOne(h, date, db, llm);
          return { ok: true as const, row };
        } catch (err) {
          log.warn(
            { symbol: h.symbol, err: (err as Error).message },
            'portfolio analysis failed for holding',
          );
          return { ok: false as const };
        }
      }),
    ),
  );

  const results: PortfolioAnalysisRow[] = [];
  let failed = 0;
  for (const o of outcomes) {
    if (o.ok) results.push(o.row);
    else failed++;
  }

  upsertPortfolioAnalysis(results, db);

  const byAction = empty();
  for (const r of results) byAction[r.action]++;

  log.info({ date, analysed: results.length, failed, byAction }, 'portfolio analyser complete');

  return { date, analysed: results.length, failed, byAction, rows: results };
}

async function analyseOne(
  h: PortfolioHoldingRow,
  date: string,
  db: DatabaseType,
  llm: LlmProvider,
): Promise<PortfolioAnalysisRow> {
  const stockContext = buildStockContext(h.symbol, date, db);
  const positionContext = buildPositionContext(h, date, db);

  const prompt = `${positionContext}\n\n${stockContext}`;
  const result = await llm.generateJson({
    system: SYSTEM_PROMPT,
    user: prompt,
    schema: PortfolioActionSchema,
    maxRetries: 1,
  });
  const a: PortfolioAction = result.data;

  return {
    symbol: h.symbol,
    date,
    action: a.action,
    conviction: a.conviction,
    thesis: a.thesis,
    bullPoints: a.bullPoints,
    bearPoints: a.bearPoints,
    triggerReason: a.triggerReason,
    suggestedStop: a.suggestedStop ?? null,
    suggestedTarget: a.suggestedTarget ?? null,
    pnlPct: h.pnlPct ?? null,
    model: llm.model,
    raw: result.raw,
  };
}

function buildPositionContext(h: PortfolioHoldingRow, date: string, db: DatabaseType): string {
  const lines: string[] = [`# Position: ${h.symbol} (${h.exchange})`];
  lines.push(`Quantity: ${h.qty}`);
  lines.push(`Avg buy price: ₹${h.avgPrice.toFixed(2)}`);
  if (h.lastPrice != null) lines.push(`Last price: ₹${h.lastPrice.toFixed(2)}`);
  if (h.pnl != null) lines.push(`Unrealised P&L: ₹${h.pnl.toFixed(2)}`);
  if (h.pnlPct != null) lines.push(`Unrealised P&L %: ${h.pnlPct.toFixed(2)}%`);
  if (h.dayChangePct != null) lines.push(`Day change %: ${h.dayChangePct.toFixed(2)}%`);
  if (h.product) lines.push(`Product: ${h.product}`);
  lines.push(`Source: ${h.source}`);

  // Screens that fired for this symbol in the last 5 sessions.
  const screens = db
    .prepare(`
      SELECT screen_name, date FROM screens
      WHERE symbol = ? AND date <= ?
      ORDER BY date DESC LIMIT 5
    `)
    .all(h.symbol, date) as Array<{ screen_name: string; date: string }>;
  if (screens.length > 0) {
    lines.push('\n## Recent screen matches (last 5)');
    for (const s of screens) lines.push(`- ${s.date}: ${s.screen_name}`);
  }

  // Active alerts on this symbol.
  const alerts = db
    .prepare(`
      SELECT date, kind, message FROM alerts
      WHERE symbol = ? AND date >= date(?, '-3 days')
      ORDER BY date DESC LIMIT 5
    `)
    .all(h.symbol, date) as Array<{ date: string; kind: string; message: string }>;
  if (alerts.length > 0) {
    lines.push('\n## Recent alerts');
    for (const a of alerts) lines.push(`- ${a.date} ${a.kind}: ${a.message}`);
  }

  return lines.join('\n');
}

function empty(): Record<'HOLD' | 'ADD' | 'TRIM' | 'EXIT', number> {
  return { HOLD: 0, ADD: 0, TRIM: 0, EXIT: 0 };
}
