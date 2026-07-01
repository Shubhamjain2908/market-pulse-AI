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
  getDb,
  getLatestHoldings,
  type PaperTradeSignalType,
  type PortfolioAnalysisRow,
  type PortfolioHoldingRow,
  upsertPortfolioAnalysis,
} from '../db/index.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { getLlmProvider } from '../llm/index.js';
import type { LlmProvider } from '../llm/types.js';
import { child } from '../logger.js';
import { lastOpenOnOrBefore } from '../market/trading-days.js';
import type { Regime } from '../types/regime.js';
import {
  computeInvestedPortfolioWeights,
  formatConcentrationContextLine,
  isAllocationInstrument,
  isDefensiveRegime,
  loadPortfolioRegimeContext,
} from './portfolio-context.js';
import {
  applyStrategyPortfolioGuardrails,
  getQualityGarpDeteriorationFlagsForSymbol,
  type PortfolioEntrySource,
  resolveHoldingEntrySource,
  type StrategyGuardrailCtx,
  truncateTriggerReason,
} from './portfolio-strategy-guardrails.js';
import {
  buildPortfolioStructureContext,
  enrichActionWithStructureContext,
  formatStructureContextBlock,
} from './portfolio-structure.js';
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
7. Do NOT recommend ADD when volume_ratio_20d < 0.5 — thin participation vs the 20-day average
   suggests weak conviction on up-moves; prefer HOLD and cite participation risk.
8. AVERAGING DOWN: If you recommend ADD on a position with negative unrealised P&L, you MUST:
   (a) state the % gain from \`Last price\` to \`Avg buy price\` (breakeven gain) in \`triggerReason\`;
   (b) ensure \`suggestedStop\` is far enough below current price that breakeven gain <= ~1.5x
   the stop's downside %. If R:R is worse than 1.5x or breakeven > 12%, default to HOLD and explain why.
9. Do NOT recommend ADD if the current price is within 2% above the most recent paper trade
   entry price for this symbol. An ADD signal requires either (a) a meaningful pullback of at
   least one ATR from the prior entry, or (b) a confirmed breakout to a new high on volume > 1.5x
   average. Adding within 2% of a prior entry price creates a cluster of stops at the same level -
   a single adverse move closes all positions simultaneously.
10. For liquid funds, gold ETFs, silver ETFs, index ETFs, and Sovereign Gold Bonds, RSI and
    volume ratio are not meaningful signals - do not reference them in your analysis.
11. When REGIME is BEAR_TRENDING or CRISIS in the user message, default to HOLD or TRIM;
    recommend ADD only with exceptional idiosyncratic evidence from the holding-specific data.

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
  latestPaperEntry: { entryPrice: number; sourceDate: string } | null,
): PortfolioAction {
  if (action.action !== 'ADD') return action;

  const symbol = action.symbol.toUpperCase();
  const isSignalExcluded = isAllocationInstrument(symbol);
  const rsi = signals.rsi_14;
  const pctHi = signals.pct_from_52w_high;
  const volRatio = signals.volume_ratio_20d;
  const overbought = !isSignalExcluded && rsi != null && rsi > 70;
  const near52wHigh = pctHi != null && pctHi >= -3;
  const weakVolume =
    !isSignalExcluded && volRatio != null && Number.isFinite(volRatio) && volRatio < 0.5;
  if (overbought || near52wHigh || weakVolume) {
    const bits: string[] = [];
    if (overbought) bits.push(`RSI ${rsi?.toFixed(0)} > 70`);
    if (near52wHigh) bits.push(`≤3% from 52W high (${pctHi?.toFixed(1)}% off high)`);
    if (weakVolume)
      bits.push(`volume_ratio_20d ${volRatio?.toFixed(2)} < 0.5 (weak participation)`);
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

  // Rule 9: Clustering guard — block ADD within 2% of prior paper entry unless breakout/pullback
  if (latestPaperEntry && lastPrice != null) {
    const entryPrice = latestPaperEntry.entryPrice;
    const proximityPct = ((lastPrice - entryPrice) / entryPrice) * 100;
    const atr = signals.atr_14;
    const volRatio = signals.volume_ratio_20d;

    const isPullback = atr != null && lastPrice <= entryPrice - atr;
    const isBreakout = volRatio != null && volRatio > 1.5;

    if (proximityPct > 0 && proximityPct <= 2 && !isPullback && !isBreakout) {
      const suffix = `[Guardrail: ADD blocked — price within 2% of prior entry (₹${entryPrice.toFixed(2)}) without ATR pullback or 1.5x vol breakout.]`;
      return {
        ...action,
        action: 'HOLD',
        conviction: Math.min(action.conviction, 0.55),
        triggerReason: truncateTriggerReason(`${action.triggerReason} ${suffix}`),
      };
    }
  }

  return action;
}

function applyOpenPaperTradeAddBlock(action: PortfolioAction, openCount: number): PortfolioAction {
  if (action.action !== 'ADD' || openCount < 1) return action;
  const symbol = action.symbol.toUpperCase();
  const note = `ADD blocked — existing open position(s) in paper ledger: ${openCount} open trades for ${symbol}`;
  return {
    ...action,
    action: 'HOLD',
    conviction: Math.min(action.conviction, 0.55),
    triggerReason: truncateTriggerReason(`${action.triggerReason} [${note}]`),
  };
}

function getOpenPaperTradeCountForSymbol(symbol: string, db: DatabaseType): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM paper_trades WHERE symbol = ? AND status = 'OPEN'`)
    .get(symbol.toUpperCase()) as { c: number };
  return row.c;
}

interface LatestPaperTradeContext {
  entryPrice: number;
  sourceDate: string;
  signalType: PaperTradeSignalType;
}

function getMostRecentPaperTradeEntry(
  symbol: string,
  asOfDate: string,
  db: DatabaseType,
): LatestPaperTradeContext | null {
  const row = db
    .prepare(
      `
      SELECT entry_price AS entryPrice, source_date AS sourceDate, signal_type AS signalType
      FROM paper_trades
      WHERE symbol = ? AND source_date <= ?
      ORDER BY source_date DESC, id DESC
      LIMIT 1
    `,
    )
    .get(symbol.toUpperCase(), asOfDate) as
    | { entryPrice: number; sourceDate: string; signalType: PaperTradeSignalType }
    | undefined;
  return row ?? null;
}

function sanitizeStockContextForExcludedSignals(symbol: string, context: string): string {
  if (!isAllocationInstrument(symbol)) return context;
  return context
    .split('\n')
    .filter((line) => !/^\s*(rsi_14|volume_ratio_20d)\s*:/.test(line))
    .join('\n');
}

export interface PortfolioAnalyserOptions {
  /** ISO date (YYYY-MM-DD). Defaults to today IST. */
  date?: string;
  /** Only analyse these symbols. Defaults to all holdings. */
  symbols?: string[];
  /** Minimum position value in INR to analyse. Default 0. */
  minPositionInr?: number;
  /** LLM concurrency limit. Defaults to config value. */
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

  const holdingsAsOf = filtered[0]?.asOf;
  const expectedSession = expectedPortfolioSessionDate(date);
  const hasKiteHolding = filtered.some((h) => h.source === 'kite');
  if (hasKiteHolding && holdingsAsOf && holdingsAsOf < expectedSession) {
    const rows = buildStaleKiteHoldingsRows(filtered, date, holdingsAsOf);
    upsertPortfolioAnalysis(rows, db);
    log.warn(
      {
        staleHoldings: true,
        briefingPortfolio: true,
        holdingsAsOf,
        expectedSession,
        analysisDate: date,
        symbolCount: filtered.length,
      },
      'STALE_HOLDINGS: Kite portfolio snapshot is older than the expected NSE session; skipped LLM portfolio review',
    );
    const byAction = empty();
    for (const r of rows) byAction[r.action]++;
    return {
      date,
      analysed: rows.length,
      failed: 0,
      fullLlmCount: 0,
      liteCount: 0,
      byAction,
      rows,
    };
  }

  const weightResult = computeInvestedPortfolioWeights(allHoldings);
  const allocationQueue = filtered.filter((h) => isAllocationInstrument(h.symbol));
  const equityQueue = filtered.filter((h) => !isAllocationInstrument(h.symbol));
  const regimeCtx = loadPortfolioRegimeContext(date, db);

  const allocationRows = allocationQueue.map((h) =>
    buildAllocationCarryRow(h, date, weightResult.weightsPct),
  );

  const fullQueue: PortfolioHoldingRow[] = [];
  const liteQueue: PortfolioHoldingRow[] = [];
  for (const h of equityQueue) {
    if (needsPortfolioLlmReview(h, date, db)) fullQueue.push(h);
    else liteQueue.push(h);
  }

  log.info(
    {
      date,
      holdings: filtered.length,
      allocation: allocationQueue.length,
      equity: equityQueue.length,
      fullLlm: fullQueue.length,
      lite: liteQueue.length,
      concurrency,
    },
    'portfolio analyser starting',
  );

  const liteRows = liteQueue.map((h) =>
    buildLitePortfolioRow(h, date, db, weightResult.weightsPct),
  );

  const limit = pLimit(concurrency);
  const outcomes = await Promise.all(
    fullQueue.map((h) =>
      limit(async () => {
        try {
          const row = await analyseOne(
            h,
            date,
            db,
            llm,
            weightResult.weightsPct,
            weightResult.investedTotalInr,
            regimeCtx.append,
            regimeCtx.regime,
          );
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

  const results = [...allocationRows, ...liteRows, ...fullResults];
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

function buildAllocationCarryRow(
  h: PortfolioHoldingRow,
  date: string,
  weightsPct: Map<string, number>,
): PortfolioAnalysisRow {
  const weight = weightsPct.get(h.symbol.toUpperCase()) ?? 0;
  const weightNote = weight > 0 ? ` Weight ${weight.toFixed(1)}% of invested book.` : '';
  return {
    symbol: h.symbol,
    date,
    action: 'HOLD',
    conviction: 0,
    thesis: `Allocation sleeve (ETF/SGB/liquid fund): carry or rebalance to target allocation only; equity ADD/TRIM/EXIT rules do not apply.${weightNote}`,
    bullPoints: ['Allocation instrument — hold for sleeve target, not equity thesis'],
    bearPoints: ['Rebalance if sleeve drifts from target allocation'],
    triggerReason: 'ALLOCATION_INSTRUMENT — excluded from equity review',
    suggestedStop: null,
    suggestedTarget: null,
    pnlPct: h.pnlPct ?? null,
    model: 'none',
    raw: null,
  };
}

function buildLitePortfolioRow(
  h: PortfolioHoldingRow,
  date: string,
  db: DatabaseType,
  weightsPct: Map<string, number>,
): PortfolioAnalysisRow {
  const copy = buildLiteSnapshotCopy(h, date, db);
  const signals = getLatestSignalsMap(h.symbol, date, db);
  const latestPaperEntry = getMostRecentPaperTradeEntry(h.symbol, date, db);
  const entrySource = resolveHoldingEntrySource(h.symbol, date, db);
  const guardCtx: StrategyGuardrailCtx = {
    symbol: h.symbol,
    date,
    entrySource,
    db,
    pnlPct: h.pnlPct ?? null,
    weightPct: weightsPct.get(h.symbol.toUpperCase()) ?? null,
  };
  const baseAction: PortfolioAction = {
    symbol: h.symbol,
    action: 'HOLD' as const,
    conviction: 0.35,
    thesis: copy.thesis,
    bullPoints: copy.bullPoints,
    bearPoints: copy.bearPoints,
    triggerReason: copy.triggerReason,
    suggestedStop: null,
    suggestedTarget: null,
  };
  const g = applyStrategyPortfolioGuardrails(
    applyPortfolioAddGuardrails(
      baseAction,
      signals,
      { pnlPct: h.pnlPct ?? null, lastPrice: h.lastPrice ?? null },
      latestPaperEntry,
    ),
    signals,
    guardCtx,
  );
  const enriched = enrichActionWithStructureContext(g, signals);

  return {
    symbol: h.symbol,
    date,
    action: enriched.action,
    conviction: enriched.conviction,
    thesis: enriched.thesis,
    bullPoints: enriched.bullPoints,
    bearPoints: enriched.bearPoints,
    triggerReason: enriched.triggerReason,
    suggestedStop: g.suggestedStop ?? null,
    suggestedTarget: g.suggestedTarget ?? null,
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
  weightsPct: Map<string, number>,
  investedTotalInr: number,
  regimeContextAppend: string | null,
  regime: Regime | null,
): Promise<PortfolioAnalysisRow> {
  const entrySource = resolveHoldingEntrySource(h.symbol, date, db);
  const stockContext = sanitizeStockContextForExcludedSignals(
    h.symbol,
    buildStockContext(h.symbol, date, db, 'portfolio'),
  );
  const positionContext = buildPositionContext(
    h,
    date,
    db,
    entrySource,
    weightsPct,
    investedTotalInr,
  );
  const openPaperTradeCount = getOpenPaperTradeCountForSymbol(h.symbol, db);
  const deep = h.pnlPct != null && h.pnlPct <= getPortfolioDeepLossPct();
  let system = deep ? `${PORTFOLIO_SYSTEM}${portfolioDeepLossAddon()}` : PORTFOLIO_SYSTEM;
  if (isDefensiveRegime(regime)) {
    system = `${system}\n\nACTIVE REGIME: ${regime} — apply rule 11 strictly.`;
  }

  const promptParts = [positionContext, stockContext];
  if (regimeContextAppend) promptParts.push(regimeContextAppend);
  const prompt = promptParts.join('\n\n');
  const result = await llm.generateJson({
    system,
    user: prompt,
    schema: PortfolioActionSchema,
    maxRetries: 1,
  });
  const signals = getLatestSignalsMap(h.symbol, date, db);
  const latestPaperEntry = getMostRecentPaperTradeEntry(h.symbol, date, db);
  const guardCtx: StrategyGuardrailCtx = {
    symbol: h.symbol,
    date,
    entrySource,
    db,
    pnlPct: h.pnlPct ?? null,
    weightPct: weightsPct.get(h.symbol.toUpperCase()) ?? null,
  };
  const a: PortfolioAction = applyStrategyPortfolioGuardrails(
    applyPortfolioAddGuardrails(
      applyOpenPaperTradeAddBlock(result.data, openPaperTradeCount),
      signals,
      {
        pnlPct: h.pnlPct ?? null,
        lastPrice: h.lastPrice ?? null,
      },
      latestPaperEntry,
    ),
    signals,
    guardCtx,
  );
  const enriched = enrichActionWithStructureContext(a, signals);

  return {
    symbol: h.symbol,
    date,
    action: enriched.action,
    conviction: enriched.conviction,
    thesis: enriched.thesis,
    bullPoints: enriched.bullPoints,
    bearPoints: enriched.bearPoints,
    triggerReason: enriched.triggerReason,
    suggestedStop: a.suggestedStop ?? null,
    suggestedTarget: a.suggestedTarget ?? null,
    pnlPct: h.pnlPct ?? null,
    model: llm.model,
    raw: result.raw,
  };
}

function buildPositionContext(
  h: PortfolioHoldingRow,
  date: string,
  db: DatabaseType,
  entrySource: PortfolioEntrySource,
  weightsPct: Map<string, number>,
  investedTotalInr: number,
): string {
  const symbol = h.symbol.toUpperCase();
  const isSignalExcluded = isAllocationInstrument(symbol);
  const positionValue = h.qty * (h.lastPrice ?? h.avgPrice);
  const weightPct = weightsPct.get(symbol) ?? null;
  const lines: string[] = [`# Position: ${h.symbol} (${h.exchange})`];
  lines.push(`Quantity: ${h.qty}`);
  lines.push(`Avg buy price: ₹${h.avgPrice.toFixed(2)}`);
  if (h.lastPrice != null) lines.push(`Last price: ₹${h.lastPrice.toFixed(2)}`);
  lines.push(`Current position value: ₹${positionValue.toFixed(2)}`);
  if (weightPct != null && investedTotalInr > 0) {
    lines.push(`Current portfolio weight (invested book): ${weightPct.toFixed(2)}%`);
    const conc = formatConcentrationContextLine(weightPct);
    if (conc) lines.push(conc);
  }
  if (h.pnl != null) lines.push(`Unrealised P&L: ₹${h.pnl.toFixed(2)}`);
  if (h.pnlPct != null) lines.push(`Unrealised P&L %: ${h.pnlPct.toFixed(2)}%`);
  if (h.dayChangePct != null) lines.push(`Day change %: ${h.dayChangePct.toFixed(2)}%`);
  if (h.product) lines.push(`Product: ${h.product}`);
  lines.push(`Source: ${h.source}`);
  if (isSignalExcluded) {
    lines.push('Signal treatment: RSI and volume ratio are excluded for this ETF/SGB symbol.');
  }

  const qgFlags = getQualityGarpDeteriorationFlagsForSymbol(symbol, date, db);
  if (qgFlags.length > 0) {
    lines.push(
      `\nQuality deterioration flags (${qgFlags.length}): ${qgFlags.join(', ')} — review TRIM; EXIT only when entry source is quality_garp and severe.`,
    );
  }

  const openPaperTradeCount = getOpenPaperTradeCountForSymbol(symbol, db);
  const latestPaperEntry = getMostRecentPaperTradeEntry(symbol, date, db);
  lines.push('\n## Paper Trade Ledger Context');
  lines.push(`Open paper trades: ${openPaperTradeCount}`);
  lines.push(`Entry source: ${entrySource}`);
  if (latestPaperEntry) {
    lines.push(`Paper signal type: ${latestPaperEntry.signalType}`);
    lines.push(
      `Most recent paper trade entry: ₹${latestPaperEntry.entryPrice.toFixed(2)} (${latestPaperEntry.sourceDate})`,
    );
  } else {
    lines.push('Most recent paper trade entry: none');
  }

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
    for (const a of alerts) {
      if (
        isSignalExcluded &&
        (a.kind === 'rsi_overbought' || a.kind === 'rsi_oversold' || a.kind === 'volume_spike')
      ) {
        continue;
      }
      lines.push(`- ${a.date} ${a.kind}: ${a.message}`);
    }
  }

  const signals = getLatestSignalsMap(h.symbol, date, db);
  const structure = buildPortfolioStructureContext(signals);
  if (structure) {
    lines.push('\n## Structural context (Weinstein stage)');
    lines.push(formatStructureContextBlock(structure));
  } else if (!signals.mom_rank) {
    lines.push(
      '\n## Structural context: no momentum rank — use weinstein_stage_* technical signals when present (run enrich).',
    );
  }

  return lines.join('\n');
}

function empty(): Record<'HOLD' | 'ADD' | 'TRIM' | 'EXIT', number> {
  return { HOLD: 0, ADD: 0, TRIM: 0, EXIT: 0 };
}

/** Last NSE cash session on or before the briefing/analysis calendar day (IST). */
function expectedPortfolioSessionDate(briefingDate: string): string {
  return lastOpenOnOrBefore(briefingDate) ?? briefingDate;
}

function buildStaleKiteHoldingsRows(
  holdings: PortfolioHoldingRow[],
  analysisDate: string,
  asOf: string,
): PortfolioAnalysisRow[] {
  const triggerReason = `STALE_HOLDINGS — Kite token not refreshed. as_of: ${asOf}`;
  return holdings.map((h) => ({
    symbol: h.symbol,
    date: analysisDate,
    action: 'HOLD' as const,
    conviction: 0,
    thesis: 'Skipped: stale portfolio holdings',
    bullPoints: [],
    bearPoints: [],
    triggerReason,
    suggestedStop: null,
    suggestedTarget: null,
    pnlPct: h.pnlPct ?? null,
    model: 'none',
    raw: null,
  }));
}
