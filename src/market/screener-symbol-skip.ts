import { BENCHMARK_QUOTE_SYMBOLS, GLOBAL_MACRO_QUOTE_SYMBOLS } from './benchmarks.js';

const NO_SCREENER_PAGE = new Set<string>(
  [...BENCHMARK_QUOTE_SYMBOLS, ...GLOBAL_MACRO_QUOTE_SYMBOLS].map((s) => s.toUpperCase()),
);

/**
 * Screener.in `/company/<SYMBOL>/` only lists operating companies — not SGBs,
 * index proxies, or Yahoo macro tickers we store under canonical names.
 */
export function skipScreenerFundamentalsFetch(symbol: string): boolean {
  const s = symbol.trim().toUpperCase();
  if (/-GB$/i.test(s)) return true;
  return NO_SCREENER_PAGE.has(s);
}
