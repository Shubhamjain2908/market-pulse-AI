/**
 * Global cues section: macro indices and FX/commodities from `quotes` (Yahoo ingest).
 * Nifty 50 spot uses the same cash benchmark series as Market Mood when shown here.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { GLOBAL_MACRO_QUOTE_SYMBOLS, NIFTY_BENCHMARK_SYMBOL } from './benchmarks.js';
import { latestQuoteClose, sessionChangeVsPriorClose } from './quote-change.js';

export interface GlobalCueRow {
  label: string;
  /** Primary cell (often Δ% or level). */
  display: string;
  changePct: number | null;
  asOf?: string;
  stale: boolean;
  /** Extra footnote (e.g. proxy explanation). */
  note?: string;
}

export interface GlobalCuesSection {
  rows: GlobalCueRow[];
}

const MACRO_LABELS: Record<string, string> = {
  DOW_JONES: 'Dow Jones',
  NASDAQ: 'Nasdaq Composite',
  SP500: 'S&P 500',
  USD_INR: 'USD/INR',
  CRUDE_WTI: 'WTI crude',
  DXY: 'US Dollar Index',
};

export function gatherGlobalCues(briefingDate: string, db: DatabaseType): GlobalCuesSection {
  const rows: GlobalCueRow[] = [];

  const gift = sessionChangeVsPriorClose(NIFTY_BENCHMARK_SYMBOL, briefingDate, db);
  const giftClose = latestQuoteClose(NIFTY_BENCHMARK_SYMBOL, briefingDate, db);
  if (gift && giftClose) {
    const stale = gift.asOf < briefingDate;
    const sign = gift.changePct >= 0 ? '+' : '';
    rows.push({
      label: 'Nifty 50 spot',
      display: `${sign}${gift.changePct.toFixed(2)}% · ${formatNum(giftClose.close)}`,
      changePct: gift.changePct,
      asOf: gift.asOf,
      stale,
      note: 'Cash Nifty 50 (Yahoo benchmark). Not GIFT-denominated futures.',
    });
  }

  for (const sym of GLOBAL_MACRO_QUOTE_SYMBOLS) {
    const ch = sessionChangeVsPriorClose(sym, briefingDate, db);
    const lv = latestQuoteClose(sym, briefingDate, db);
    if (!ch || !lv) continue;
    const stale = ch.asOf < briefingDate;
    const sign = ch.changePct >= 0 ? '+' : '';
    rows.push({
      label: MACRO_LABELS[sym] ?? sym,
      display: `${sign}${ch.changePct.toFixed(2)}% · ${formatMacroLevel(sym, lv.close)}`,
      changePct: ch.changePct,
      asOf: ch.asOf,
      stale,
    });
  }

  return { rows };
}

function formatNum(n: number): string {
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function formatMacroLevel(symbol: string, close: number): string {
  if (symbol === 'USD_INR') return `₹${close.toFixed(2)}`;
  if (symbol === 'CRUDE_WTI') return `$${close.toFixed(2)}`;
  if (symbol === 'DXY') return close.toFixed(2);
  return formatNum(close);
}
