/**
 * advice-review — Deterministic advice-accuracy scorer for `portfolio_analysis`.
 *
 * OBSERVE-SAFE: read-only diagnostic. Zero LLM, zero schema change, zero gating
 * impact. Rerunnable — same DB state → same output.
 *
 * Scores each action-transition (deduplicated repeated actions) against
 * 30/60/90-calendar-day forward returns from `quotes`, with NIFTY_50 as
 * benchmark. Output: by-action stats, conviction-band cuts, 10 worst calls.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { getDb } from '../db/connection.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { NIFTY_BENCHMARK_SYMBOL } from '../market/benchmarks.js';
import {
  addCalendarDaysIst,
  lastOpenOnOrBefore,
  nextOpenOnOrAfter,
} from '../market/trading-days.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PortfolioCall {
  symbol: string;
  date: string;
  action: 'HOLD' | 'ADD' | 'TRIM' | 'EXIT';
  conviction: number;
}

export interface HorizonReturns {
  r30: number | null;
  r60: number | null;
  r90: number | null;
  x30: number | null;
  x60: number | null;
  x90: number | null;
  benchmarkR30: number | null;
  benchmarkR60: number | null;
  benchmarkR90: number | null;
  entryPrice: number | null;
  horizonStatus: 'scorable' | 'pending' | 'unscorable_no_entry';
  entryDate: string | null;
}

export interface ScoredCall extends PortfolioCall, HorizonReturns {
  correct: boolean | null;
}

export interface ActionStats {
  transitions: number;
  scorable: number;
  unscorableNoHorizon: number;
  pending: number;
  correct: number;
  hitRate: number | null;
  avgX30: number | null;
  avgX60: number | null;
  avgX90: number | null;
  avgRawR90: number | null;
}

export interface ConvictionBand {
  band: string;
  action: string;
  transitions: number;
  hitRate: number | null;
}

export interface AdviceReviewResult {
  date: string;
  totalCalls: number;
  scoredTransitions: number;
  pending: number;
  unscorableNoEntry: number;
  unscorableNoHorizon: number;
  byAction: Record<string, ActionStats>;
  convictionBands: ConvictionBand[];
  worstCalls: ScoredCall[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HORIZON_DAYS: ReadonlyArray<30 | 60 | 90> = [30, 60, 90];
const WALK_BACK_LIMIT = 10;

/**
 * First NSE `quotes.close` on or after `callDate`, within 7 calendar days.
 * Returns null → `unscorable_no_entry`.
 */
function tryGetEntryPrice(
  symbol: string,
  callDate: string,
  db: DatabaseType,
): { price: number; date: string } | null {
  const deadline = addCalendarDaysIst(callDate, 7);

  let cur = callDate;
  for (let attempts = 0; attempts < 10; attempts++) {
    const session = nextOpenOnOrAfter(cur);
    if (!session || session > deadline) return null;

    const row = db
      .prepare(`SELECT close FROM quotes WHERE symbol = ? AND exchange = 'NSE' AND date = ?`)
      .get(symbol, session) as { close: number } | undefined;

    if (row && Number.isFinite(row.close)) {
      return { price: row.close, date: session };
    }

    cur = addCalendarDaysIst(session, 1);
  }

  return null;
}

/**
 * Latest NSE `quotes.close` on or before `targetDate`.
 *
 * Tries the exact calendar session first. If the symbol has no quote on that
 * day (suspension, patchy ingest), walks back through up to `WALK_BACK_LIMIT`
 * prior trading sessions looking for the symbol's last available close.
 * Returns null when no quote found in the bounded walk.
 */
function getCloseOnOrBefore(symbol: string, targetDate: string, db: DatabaseType): number | null {
  const session = lastOpenOnOrBefore(targetDate);
  if (!session) return null;

  // Try exact-date lookup first
  const row = db
    .prepare(`SELECT close FROM quotes WHERE symbol = ? AND exchange = 'NSE' AND date = ?`)
    .get(symbol, session) as { close: number } | undefined;

  if (row && Number.isFinite(row.close)) return row.close;

  // Walk back through prior trading sessions, bounded
  let cur = addCalendarDaysIst(session, -1);
  for (let attempts = 0; attempts < WALK_BACK_LIMIT; attempts++) {
    const prior = lastOpenOnOrBefore(cur);
    if (!prior) return null;

    const priorRow = db
      .prepare(`SELECT close FROM quotes WHERE symbol = ? AND exchange = 'NSE' AND date = ?`)
      .get(symbol, prior) as { close: number } | undefined;

    if (priorRow && Number.isFinite(priorRow.close)) return priorRow.close;

    cur = addCalendarDaysIst(prior, -1);
  }

  return null;
}

/** Latest NSE quote date in the DB for the symbol. */
function getLatestQuoteDate(symbol: string, db: DatabaseType): string | null {
  const row = db
    .prepare(`SELECT MAX(date) AS maxDate FROM quotes WHERE symbol = ? AND exchange = 'NSE'`)
    .get(symbol) as { maxDate: string | null } | undefined;
  return row?.maxDate ?? null;
}

function computeReturn(p0: number, pH: number): number {
  return ((pH - p0) / p0) * 100;
}

/**
 * Determine whether the action was "correct" given the 90-day excess return.
 * Ties (x90 === 0): incorrect for ADD/EXIT/TRIM, correct for HOLD.
 */
function actionIsCorrect(action: string, x90: number): boolean {
  switch (action) {
    case 'EXIT':
    case 'TRIM':
      return x90 < 0;
    case 'ADD':
      return x90 > 0;
    case 'HOLD':
      return x90 > -5;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Compute forward returns for a single call.
 *
 * Benchmark returns use `getCloseOnOrBefore` for the NIFTY_50 symbol
 * (same methodology as stock returns). The `benchQuoteMap` is used to
 * look up the NIFTY entry price at the call's epoch.
 */
function scoreCall(
  call: PortfolioCall,
  benchQuoteMap: Map<string, number>,
  db: DatabaseType,
): ScoredCall {
  // --- Entry price ---
  const entry = tryGetEntryPrice(call.symbol, call.date, db);
  if (!entry) {
    return {
      ...call,
      entryPrice: null,
      entryDate: null,
      r30: null,
      r60: null,
      r90: null,
      x30: null,
      x60: null,
      x90: null,
      benchmarkR30: null,
      benchmarkR60: null,
      benchmarkR90: null,
      horizonStatus: 'unscorable_no_entry',
      correct: null,
    };
  }

  // Determine if horizons have elapsed
  const latestQd = getLatestQuoteDate(call.symbol, db);
  const p0 = entry.price;

  // Check if ALL horizons are pending
  const allTargetDates = HORIZON_DAYS.map((H) => ({
    H,
    targetDate: addCalendarDaysIst(call.date, H),
  }));
  const anyElapsed = allTargetDates.some(
    ({ targetDate }) => latestQd != null && targetDate <= latestQd,
  );

  if (!anyElapsed || !latestQd) {
    // All horizons pending
    return {
      ...call,
      entryPrice: p0,
      entryDate: entry.date,
      r30: null,
      r60: null,
      r90: null,
      x30: null,
      x60: null,
      x90: null,
      benchmarkR30: null,
      benchmarkR60: null,
      benchmarkR90: null,
      horizonStatus: 'pending',
      correct: null,
    };
  }

  // Benchmark entry price = NIFTY close on the stock's entry trading day
  const benchP0 = benchQuoteMap.get(entry.date) ?? null;

  // Compute each horizon
  const r: Record<number, number | null> = {};
  const x: Record<number, number | null> = {};
  const br: Record<number, number | null> = {};
  let overallStatus: 'scorable' | 'pending' = 'scorable';

  for (const { H, targetDate } of allTargetDates) {
    // Pending if horizon hasn't elapsed
    if (latestQd == null || targetDate > latestQd) {
      r[H] = null;
      x[H] = null;
      br[H] = null;
      if (H === 90) overallStatus = 'pending';
      continue;
    }

    // Symbol close at horizon (with walk-back for missing exact-date quote)
    const pH = getCloseOnOrBefore(call.symbol, targetDate, db);
    if (pH == null) {
      r[H] = null;
      x[H] = null;
      br[H] = null;
      continue;
    }

    const rawRet = computeReturn(p0, pH);
    r[H] = rawRet;

    // Benchmark return
    if (benchP0 != null) {
      const benchPH = getCloseOnOrBefore(NIFTY_BENCHMARK_SYMBOL, targetDate, db);
      if (benchPH != null) {
        const benchRet = computeReturn(benchP0, benchPH);
        br[H] = benchRet;
        x[H] = rawRet - benchRet;
      } else {
        br[H] = null;
        x[H] = null;
      }
    } else {
      br[H] = null;
      x[H] = null;
    }
  }

  const x90 = x[90] ?? null;
  const correct =
    overallStatus === 'scorable' && x90 != null ? actionIsCorrect(call.action, x90) : null;

  return {
    ...call,
    entryPrice: p0,
    entryDate: entry.date,
    r30: r[30] ?? null,
    r60: r[60] ?? null,
    r90: r[90] ?? null,
    x30: x[30] ?? null,
    x60: x[60] ?? null,
    x90,
    benchmarkR30: br[30] ?? null,
    benchmarkR60: br[60] ?? null,
    benchmarkR90: br[90] ?? null,
    horizonStatus: overallStatus,
    correct,
  };
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * For each symbol, keep only action-transitions (first call of a streak).
 * Prevents repeated daily HOLDs from dominating every metric.
 */
function deduplicateToTransitions(calls: PortfolioCall[]): PortfolioCall[] {
  const bySymbol = new Map<string, PortfolioCall[]>();
  for (const c of calls) {
    const list = bySymbol.get(c.symbol) ?? [];
    list.push(c);
    bySymbol.set(c.symbol, list);
  }

  const result: PortfolioCall[] = [];
  for (const [, group] of bySymbol) {
    group.sort((a, b) => a.date.localeCompare(b.date));
    let prevAction: string | null = null;
    for (const call of group) {
      if (prevAction === null || call.action !== prevAction) {
        result.push(call);
        prevAction = call.action;
      }
    }
  }

  // Stable output ordering
  result.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
  return result;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function computeActionStats(scored: ScoredCall[]): Record<string, ActionStats> {
  const byAction = new Map<string, ScoredCall[]>();
  for (const s of scored) {
    const bucket = byAction.get(s.action) ?? [];
    bucket.push(s);
    byAction.set(s.action, bucket);
  }

  const result: Record<string, ActionStats> = {};
  for (const [action, calls] of byAction) {
    // scorable = horizon elapsed AND x90 is computable (correct != null)
    const scorable = calls.filter((c) => c.horizonStatus === 'scorable' && c.correct != null);
    // unscorable with elapsed horizon but missing x90 quote data
    const unscorableNoHorizon = calls.filter(
      (c) => c.horizonStatus === 'scorable' && c.correct == null,
    ).length;
    const pending = calls.filter((c) => c.horizonStatus === 'pending').length;
    const correct = scorable.filter((c) => c.correct === true).length;
    const hitRate = scorable.length > 0 ? correct / scorable.length : null;

    const avg = (key: (c: ScoredCall) => number | null): number | null => {
      const vals = scorable.map(key).filter((v): v is number => v != null);
      return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };

    result[action] = {
      transitions: calls.length,
      scorable: scorable.length,
      unscorableNoHorizon,
      pending,
      correct,
      hitRate,
      avgX30: avg((c) => c.x30),
      avgX60: avg((c) => c.x60),
      avgX90: avg((c) => c.x90),
      avgRawR90: avg((c) => c.r90),
    };
  }

  return result;
}

function computeConvictionBands(scored: ScoredCall[]): ConvictionBand[] {
  const bands: ConvictionBand[] = [];
  const actions = [...new Set(scored.map((c) => c.action))].sort();
  const CONVICTION_BANDS: ReadonlyArray<{ label: string; min: number; max: number }> = [
    { label: '<0.5', min: 0, max: 0.5 },
    { label: '0.5–0.7', min: 0.5, max: 0.71 },
    { label: '>0.7', min: 0.71, max: 1.01 },
  ];

  for (const action of actions) {
    for (const band of CONVICTION_BANDS) {
      const inBand = scored.filter(
        (c) =>
          c.action === action &&
          c.conviction >= band.min &&
          c.conviction < band.max &&
          c.horizonStatus === 'scorable' &&
          c.correct != null,
      );
      const correct = inBand.filter((c) => c.correct).length;
      bands.push({
        band: band.label,
        action,
        transitions: inBand.length,
        hitRate: inBand.length > 0 ? correct / inBand.length : null,
      });
    }
  }

  return bands;
}

// ---------------------------------------------------------------------------
// Formatting & output
// ---------------------------------------------------------------------------

function formatTable(result: AdviceReviewResult): string {
  const lines: string[] = [];

  lines.push(`Advice Review — ${result.date}`);
  lines.push(
    `Total calls: ${result.totalCalls} → ${result.scoredTransitions} transitions (deduped)`,
  );
  lines.push(
    `Pending: ${result.pending} | Unscorable (no entry): ${result.unscorableNoEntry} | Unscorable (no horizon): ${result.unscorableNoHorizon}`,
  );
  lines.push('');

  // By-action table
  const actions = Object.keys(result.byAction).sort();
  lines.push('─── By action ───');
  lines.push(
    `${header('action', 10)} ${header('transitions', 12)} ${header('scorable', 10)} ${header('noHorizon', 11)} ${header('pending', 8)} ${header('correct', 9)} ${header('hitRate', 10)} ${header('avg x30', 10)} ${header('avg x60', 10)} ${header('avg x90', 10)} ${header('avg raw r90', 14)}`,
  );
  for (const action of actions) {
    const s = result.byAction[action];
    if (!s) continue;
    lines.push(
      `${cell(action, 10)} ${cell(s.transitions, 12)} ${cell(s.scorable, 10)} ${cell(s.unscorableNoHorizon, 11)} ${cell(s.pending, 8)} ${cell(s.correct, 9)} ${pct(s.hitRate, 10)} ${pct(s.avgX30, 10)} ${pct(s.avgX60, 10)} ${pct(s.avgX90, 10)} ${pct(s.avgRawR90, 14)}`,
    );
  }
  lines.push('');

  // Conviction bands
  lines.push('─── Conviction bands (90d hit rate) ───');
  for (const b of result.convictionBands) {
    lines.push(
      `  ${b.action.padEnd(8)} ${b.band.padEnd(10)} transitions: ${String(b.transitions).padStart(4)}  hitRate: ${fmtPct(b.hitRate)}`,
    );
  }
  lines.push('');

  // Worst calls
  if (result.worstCalls.length > 0) {
    lines.push('─── 10 worst calls (by x90) ───');
    for (const w of result.worstCalls) {
      lines.push(
        `  ${w.symbol.padEnd(12)} ${w.date.padEnd(12)} ${w.action.padEnd(6)} conviction: ${w.conviction.toFixed(2).padStart(5)}  x90: ${fmtPct(w.x90)}  correct: ${w.correct === true ? '✓' : '✗'}`,
      );
    }
  }

  lines.push('');
  lines.push('Note: ADD row is advisory only. paper_trades PORTFOLIO_ADD is the ledger of record.');
  return lines.join('\n');
}

function header(label: string, width: number): string {
  return label.padStart(width);
}

function cell(value: number | string, width: number): string {
  return String(value).padStart(width);
}

function pct(value: number | null, width: number): string {
  return fmtPct(value).padStart(width);
}

function fmtPct(value: number | null): string {
  if (value == null) return '—';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export interface AdviceReviewOptions {
  /** Analysis date — bounds `portfolio_analysis` rows (default: today IST). */
  date?: string;
  /** Output raw JSON to stdout (no table formatting). */
  json?: boolean;
  /** DB instance (default: singleton). */
  db?: DatabaseType;
}

/**
 * Score past `portfolio_analysis` calls against forward returns from `quotes`.
 *
 * Steps:
 * 1. Load all portfolio_analysis rows with `date <= asOf`
 * 2. Deduplicate to action-transitions (repeated HOLDs collapsed)
 * 3. For each transition, compute 30/60/90d forward returns vs NIFTY_50 benchmark
 * 4. Determine correctness per §2.3 rules (primary: x90)
 * 5. Aggregate by action, conviction band; report 10 worst calls
 */
export function runAdviceReview(
  opts: AdviceReviewOptions = {},
  db: DatabaseType = getDb(),
): AdviceReviewResult {
  const effectiveDb = opts.db ?? db;
  const asOf = opts.date ?? isoDateIst();

  // 1. Load all portfolio_analysis rows
  const rawCalls = effectiveDb
    .prepare(
      `SELECT symbol, date, action, conviction
       FROM portfolio_analysis
       WHERE date <= ?
       ORDER BY symbol ASC, date ASC`,
    )
    .all(asOf) as Array<{
    symbol: string;
    date: string;
    action: string;
    conviction: number;
  }>;

  const totalCalls = rawCalls.length;

  const calls: PortfolioCall[] = rawCalls.map((r) => ({
    symbol: r.symbol,
    date: r.date,
    action: r.action as PortfolioCall['action'],
    conviction: r.conviction,
  }));

  // 2. Deduplicate to transitions
  const transitions = deduplicateToTransitions(calls);
  const scoredTransitions = transitions.length;

  // Pre-load benchmark quote map for fast per-call entry-price lookups
  const benchQuoteMap = new Map<string, number>();
  const benchRows = effectiveDb
    .prepare(
      `SELECT date, close FROM quotes WHERE symbol = ? AND exchange = 'NSE' ORDER BY date ASC`,
    )
    .all(NIFTY_BENCHMARK_SYMBOL) as Array<{ date: string; close: number }>;
  for (const r of benchRows) {
    benchQuoteMap.set(r.date, r.close);
  }

  // 3. Score each transition
  const scored: ScoredCall[] = [];
  let pendingCount = 0;
  let unscorableEntryCount = 0;
  let unscorableHorizonCount = 0;

  for (const call of transitions) {
    const s = scoreCall(call, benchQuoteMap, effectiveDb);

    if (s.horizonStatus === 'pending') pendingCount++;
    else if (s.horizonStatus === 'unscorable_no_entry') unscorableEntryCount++;
    else if (s.horizonStatus === 'scorable' && s.correct == null) unscorableHorizonCount++;

    scored.push(s);
  }

  // 4. Compute stats
  const byAction = computeActionStats(scored);
  const convictionBands = computeConvictionBands(scored);

  // 5. Worst calls (sorted by x90 ascending)
  const worstCalls = [...scored]
    .filter((c) => c.horizonStatus === 'scorable' && c.x90 != null)
    .sort((a, b) => (a.x90 ?? 0) - (b.x90 ?? 0))
    .slice(0, 10);

  return {
    date: asOf,
    totalCalls,
    scoredTransitions,
    pending: pendingCount,
    unscorableNoEntry: unscorableEntryCount,
    unscorableNoHorizon: unscorableHorizonCount,
    byAction,
    convictionBands,
    worstCalls,
  };
}

/**
 * Print the review result to console.
 */
export function printAdviceReview(result: AdviceReviewResult, json: boolean = false): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatTable(result));
  }
}
