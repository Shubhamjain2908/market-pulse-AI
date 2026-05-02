/**
 * Portfolio Analyser. For each holding, either runs a full LLM review (when
 * triggers fire) or persists a deterministic lite snapshot to save tokens.
 *
 * Persists per-holding analysis to portfolio_analysis. The briefing surfaces
 * it under a "My Portfolio" section.
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
import {
  buildLiteSnapshotCopy,
  getLatestSignalsMap,
  getPortfolioDeepLossPct,
  needsPortfolioLlmReview,
} from './portfolio-trigger.js';
import { buildStockContext } from './thesis-generator.js';

const log = child({ component: 'portfolio-analyser' });

export const PortfolioActionSchema = z.object({
  symbol: z.string(),
  action: z.enum(['HOLD', 'ADD', 'TRIM', 'EXIT']),
  conviction: z.number().min(0).max(1),
  thesis: z.string().min(20).max(800),
  bullPoints: z.array(z.string().min(1)).min(1).max(5),
  bearPoints: z.array(z.string().min(1)).min(1).max(5),
  /** LLMs often exceed length; truncate before guardrails so parse succeeds (matches ADD/R:R suffix truncation). */
  triggerReason: z
    .string()
    .min(5)
    .transform((s) => (s.length <= 280 ? s : `${s.slice(0, 276)}…`)),
  suggestedStop: z.number().nullable().optional(),
  suggestedTarget: z.number().nullable().optional(),
});
export type PortfolioAction = z.infer<typeof PortfolioActionSchema>;

const PORTFOLIO_SYSTEM = `You are a senior Indian-equity portfolio review analyst. The user already
OWNS the position you are analysing. Recommend ONE of four actions based ONLY on the data provided:

  HOLD  — keep the position as-is, thesis still intact
  ADD   — accumulate more on the current setup
  TRIM  — book partial profits / reduce exposure
  EXIT  — close the entire position

Rules:
1. Anchor reasoning on what CHANGED: P&L vs entry, technicals, symbol-specific news,
   screens/alerts. Do not repeat broad Indian macro flows (FII/DII, USD/INR, crude)
   in bullPoints or bearPoints unless this company's economics are directly tied
   to that risk — those appear in the Market Mood section already.
2. NEVER hallucinate financials. If a data point isn't provided, don't invoke it.
3. ADD/TRIM/EXIT need a concrete catalyst from the provided data — name it in triggerReason.
4. Conviction is 0..1. Below 0.4 → HOLD by default unless exit evidence is strong.
5. suggestedStop / suggestedTarget are optional INR numbers.
6. Do NOT recommend ADD when RSI_14 > 70 or price is within ~3% of the 52-week high
   (pct_from_52w_high >= -3). In those cases prefer HOLD and cite overbought / extended setup.
7. AVERAGING DOWN: If you recommend ADD on a position with negative unrealised P&L, you MUST:
   (a) state the % gain from \`Last price\` to \`Avg buy price\` (breakeven gain) in \`triggerReason\`;
   (b) ensure \`suggestedStop\` is far enough below current price that breakeven gain <= ~1.5x
   the stop's downside %. If R:R is worse than 1.5x or breakeven > 12%, default to HOLD and explain why.

Output ONLY a single JSON object matching the schema. No markdown fences.

Schema:
{
  "symbol": string,
  "action": "HOLD" | "ADD" | "TRIM" | "EXIT",
  "conviction": number (0..1),
  "thesis": string (20-800 chars),
  "bullPoints": string[] (1-5 items),
  "bearPoints": string[] (1-5 items),
  "triggerReason": string (5–280 chars — concise "why now"; breakeven % must fit here),
  "suggestedStop": number | null,
  "suggestedTarget": number | null
}`;

function portfolioDeepLossAddon(): string {
  const t = Math.abs(getPortfolioDeepLossPct());
  return `
CRITICAL — UNREALISED LOSS >= ${t}%:
HOLD is only acceptable if idiosyncratic recovery evidence exists in the supplied data.
Otherwise prefer TRIM or EXIT and say why. Cite the drawdown magnitude in triggerReason.`;
}

/** Code-level enforcement: ADD into extension (RSI / 52W) and averaging-down R:R. */
export function applyPortfolioAddGuardrails(
  action: PortfolioAction,
  signals: Record<string, number>,
  position: { pnlPct: number | null; lastPrice: number | null },
): PortfolioAction {
  if (action.action !== 'ADD') return action;

  const rsi = signals.rsi_14;
  const pctHi = signals.pct_from_52w_high;
  const overbought = rsi != null && rsi > 70;
  const near52wHigh = pctHi != null && pctHi >= -3;
  if (overbought || near52wHigh) {
    const bits: string[] = [];
    if (overbought) bits.push(`RSI ${rsi?.toFixed(0)} > 70`);
    if (near52wHigh) bits.push(`≤3% from 52W high (${pctHi?.toFixed(1)}% off high)`);
    const suffix = `[Guardrail: ${bits.join('; ')} — HOLD vs ADD into extension.]`;
    let triggerReason = `${action.triggerReason} ${suffix}`;
    if (triggerReason.length > 280) triggerReason = `${triggerReason.slice(0, 276)}…`;

    return {
      ...action,
      action: 'HOLD',
      conviction: Math.min(action.conviction, 0.55),
      triggerReason,
    };
  }

  const { pnlPct, lastPrice } = position;
  if (pnlPct != null && pnlPct < -8) {
    const breakevenGainPct = -pnlPct;
    let stopDownsidePct = 0;
    if (action.suggestedStop != null && lastPrice != null && lastPrice > 0) {
      stopDownsidePct = ((lastPrice - action.suggestedStop) / lastPrice) * 100;
    }
    const passes =
      stopDownsidePct >= 4 && breakevenGainPct <= 1.5 * stopDownsidePct && breakevenGainPct <= 15;

    if (!passes) {
      const suffix = `[Guardrail: averaging down requires R:R; breakeven +${breakevenGainPct.toFixed(1)}% vs stop -${stopDownsidePct.toFixed(1)}%]`;
      let triggerReason = `${action.triggerReason} ${suffix}`;
      if (triggerReason.length > 280) triggerReason = `${triggerReason.slice(0, 276)}…`;
      return {
        ...action,
        action: 'HOLD',
        conviction: Math.min(action.conviction, 0.55),
        triggerReason,
      };
    }
  }

  return action;
}

export interface PortfolioAnalyserOptions {
  date?: string;
  symbols?: string[];
  minPositionInr?: number;
  concurrency?: number;
}

export interface PortfolioAnalyserResult {
  date: string;
  analysed: number;
  failed: number;
  fullLlmCount: number;
  liteCount: number;
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
    return {
      date,
      analysed: 0,
      failed: 0,
      fullLlmCount: 0,
      liteCount: 0,
      byAction: empty(),
      rows: [],
    };
  }

  const fullQueue: PortfolioHoldingRow[] = [];
  const liteQueue: PortfolioHoldingRow[] = [];
  for (const h of filtered) {
    if (needsPortfolioLlmReview(h, date, db)) fullQueue.push(h);
    else liteQueue.push(h);
  }

  log.info(
    {
      date,
      holdings: filtered.length,
      fullLlm: fullQueue.length,
      lite: liteQueue.length,
      concurrency,
    },
    'portfolio analyser starting',
  );

  const liteRows = liteQueue.map((h) => buildLitePortfolioRow(h, date, db));

  const limit = pLimit(concurrency);
  const outcomes = await Promise.all(
    fullQueue.map((h) =>
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

  const fullResults: PortfolioAnalysisRow[] = [];
  let failed = 0;
  for (const o of outcomes) {
    if (o.ok) fullResults.push(o.row);
    else failed++;
  }

  const results = [...liteRows, ...fullResults];
  upsertPortfolioAnalysis(results, db);

  const byAction = empty();
  for (const r of results) byAction[r.action]++;

  log.info(
    {
      date,
      analysed: results.length,
      failed,
      fullLlmCount: fullResults.length,
      liteCount: liteRows.length,
      byAction,
    },
    'portfolio analyser complete',
  );

  return {
    date,
    analysed: results.length,
    failed,
    fullLlmCount: fullResults.length,
    liteCount: liteRows.length,
    byAction,
    rows: results,
  };
}

function buildLitePortfolioRow(
  h: PortfolioHoldingRow,
  date: string,
  db: DatabaseType,
): PortfolioAnalysisRow {
  const copy = buildLiteSnapshotCopy(h, date, db);
  return {
    symbol: h.symbol,
    date,
    action: 'HOLD',
    conviction: 0.35,
    thesis: copy.thesis,
    bullPoints: copy.bullPoints,
    bearPoints: copy.bearPoints,
    triggerReason: copy.triggerReason,
    suggestedStop: null,
    suggestedTarget: null,
    pnlPct: h.pnlPct ?? null,
    model: 'lite-snapshot-v1',
    raw: null,
  };
}

async function analyseOne(
  h: PortfolioHoldingRow,
  date: string,
  db: DatabaseType,
  llm: LlmProvider,
): Promise<PortfolioAnalysisRow> {
  const stockContext = buildStockContext(h.symbol, date, db, 'portfolio');
  const positionContext = buildPositionContext(h, date, db);
  const deep = h.pnlPct != null && h.pnlPct <= getPortfolioDeepLossPct();
  const system = deep ? `${PORTFOLIO_SYSTEM}${portfolioDeepLossAddon()}` : PORTFOLIO_SYSTEM;

  const prompt = `${positionContext}\n\n${stockContext}`;
  const result = await llm.generateJson({
    system,
    user: prompt,
    schema: PortfolioActionSchema,
    maxRetries: 1,
  });
  const signals = getLatestSignalsMap(h.symbol, date, db);
  const a: PortfolioAction = applyPortfolioAddGuardrails(result.data, signals, {
    pnlPct: h.pnlPct ?? null,
    lastPrice: h.lastPrice ?? null,
  });

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
