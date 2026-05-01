/**
 * Map canonical NSE symbols (as stored in our DB) to Yahoo Finance tickers.
 */

import { YAHOO_CHART_TICKER_OVERRIDES } from './benchmarks.js';

export function toYahooFinanceTicker(symbol: string): string {
  const u = symbol.toUpperCase();
  const override = YAHOO_CHART_TICKER_OVERRIDES[u];
  if (override) return override;
  if (symbol.includes('.')) return u;
  return `${u}.NS`;
}
