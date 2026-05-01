/**
 * Benchmark indices stored as canonical symbols in `quotes`. Yahoo Finance
 * chart tickers differ (e.g. Nifty is ^NSEI); see Yahoo ingestor overrides.
 */

/** Stored in DB as `quotes.symbol` — populated by the Yahoo ingestor. */
export const NIFTY_BENCHMARK_SYMBOL = 'NIFTY_50';
export const INDIA_VIX_BENCHMARK_SYMBOL = 'INDIA_VIX';

export const BENCHMARK_QUOTE_SYMBOLS: readonly string[] = [
  NIFTY_BENCHMARK_SYMBOL,
  INDIA_VIX_BENCHMARK_SYMBOL,
];

/** Map canonical symbol → Yahoo chart ticker. */
export const YAHOO_CHART_TICKER_OVERRIDES: Readonly<Record<string, string>> = {
  NIFTY_50: '^NSEI',
  INDIA_VIX: '^INDIAVIX',
};
