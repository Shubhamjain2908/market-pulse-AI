/**
 * Shared portfolio analyser context: weights, regime, fundamentals display, allocation routing.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { normalizeFundamentalForScreen } from '../analysers/signal-provider.js';
import { loadEtfExclusions } from '../config/loaders.js';
import type { PortfolioHoldingRow } from '../db/index.js';
import { getRegimeForCalendarDate } from '../db/regime-queries.js';
import type { Regime } from '../types/regime.js';

export const SOFT_CONCENTRATION_PCT = 10;
export const HARD_CONCENTRATION_PCT = 15;
export const CASH_PROXY_SYMBOL = 'LIQUIDCASE';

const PERCENT_DISPLAY_COLUMNS = new Set([
  'roe',
  'roce',
  'dividend_yield',
  'revenue_growth_yoy',
  'profit_growth_yoy',
]);

const ALLOCATION_INSTRUMENTS = new Set(loadEtfExclusions().map((s) => s.toUpperCase()));

export function isAllocationInstrument(symbol: string): boolean {
  return ALLOCATION_INSTRUMENTS.has(symbol.toUpperCase());
}

function holdingValueInr(h: PortfolioHoldingRow): number {
  return h.qty * (h.lastPrice ?? h.avgPrice);
}

/** Weight % uses invested book; LIQUIDCASE is excluded from the denominator only. */
export function computeInvestedPortfolioWeights(holdings: PortfolioHoldingRow[]): {
  investedTotalInr: number;
  weightsPct: Map<string, number>;
} {
  const investedTotalInr = holdings
    .filter((h) => h.symbol.toUpperCase() !== CASH_PROXY_SYMBOL)
    .reduce((sum, h) => sum + holdingValueInr(h), 0);

  const weightsPct = new Map<string, number>();
  for (const h of holdings) {
    const sym = h.symbol.toUpperCase();
    const pct = investedTotalInr > 0 ? (holdingValueInr(h) / investedTotalInr) * 100 : 0;
    weightsPct.set(sym, pct);
  }

  return { investedTotalInr, weightsPct };
}

export function formatConcentrationContextLine(weightPct: number): string | null {
  if (weightPct < SOFT_CONCENTRATION_PCT) return null;
  const soft = `Soft limit ${SOFT_CONCENTRATION_PCT}%`;
  const hard =
    weightPct >= HARD_CONCENTRATION_PCT
      ? ` — exceeds hard ${HARD_CONCENTRATION_PCT}% TRIM threshold`
      : ` — prefer TRIM unless thesis strongly intact`;
  return `CONCENTRATION: ${weightPct.toFixed(1)}% of invested book (${CASH_PROXY_SYMBOL} excluded from denominator). ${soft}${hard}.`;
}

export function isDefensiveRegime(regime: Regime | null | undefined): boolean {
  return regime === 'BEAR_TRENDING' || regime === 'CRISIS';
}

/** Single regime read for portfolio LLM posture block + defensive system rule. */
export function loadPortfolioRegimeContext(
  date: string,
  db: DatabaseType,
): { append: string | null; regime: Regime | null } {
  const row = getRegimeForCalendarDate(date, db);
  if (!row) return { append: null, regime: null };

  const posture = isDefensiveRegime(row.regime)
    ? 'In BEAR_TRENDING/CRISIS: default HOLD/TRIM; ADD requires exceptional idiosyncratic evidence in the data below.'
    : 'Use regime as portfolio posture context; still anchor each holding on its own data.';

  return {
    regime: row.regime,
    append: [
      '## Market regime (portfolio posture)',
      `REGIME: ${row.regime} (score ${row.scoreTotal.toFixed(1)}, age ${row.regimeAge}d).`,
      posture,
    ].join('\n'),
  };
}

function formatFundamentalValue(column: string, value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);
  const normalized = normalizeFundamentalForScreen(column, value);
  if (PERCENT_DISPLAY_COLUMNS.has(column)) {
    return `${normalized.toFixed(2)}%`;
  }
  return normalized.toFixed(4).replace(/\.?0+$/, '') || '0';
}

const FUNDAMENTAL_SKIP_KEYS = new Set(['symbol', 'as_of', 'ingested_at', 'source']);

/** Human-readable fundamentals block for LLM context (no DB mutation). */
export function formatFundamentalsForLlm(row: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(row)) {
    if (v == null || FUNDAMENTAL_SKIP_KEYS.has(k)) continue;
    if (typeof v === 'number') {
      lines.push(`${k}: ${formatFundamentalValue(k, v)}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  return lines;
}
