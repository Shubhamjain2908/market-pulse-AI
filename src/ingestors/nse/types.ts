/**
 * Subset of the NSE response shapes we depend on. The actual payloads are
 * much larger; we model only the fields we read.
 *
 * Note: NSE's FII/DII endpoint returns numeric fields as STRINGS (e.g.
 * "18252.89"). We type them accurately and coerce in the ingestor mapper.
 */

export interface NseQuoteResponse {
  info?: { symbol?: string; companyName?: string };
  metadata?: { lastUpdateTime?: string };
  priceInfo?: {
    open?: number;
    close?: number;
    lastPrice?: number;
    previousClose?: number;
    intraDayHighLow?: { min?: number; max?: number };
  };
  preOpenMarket?: {
    totalTradedVolume?: number;
  };
  securityWiseDP?: {
    quantityTraded?: number;
  };
}

/**
 * One row per category from `/api/fiidiiTradeReact`. Two rows are returned
 * per response: category="FII/FPI" and category="DII".
 *
 * Numeric fields are typed as `string | number` because NSE has historically
 * emitted them as strings ("18252.89") but reserves the right to change to
 * native numbers without warning. The mapper coerces with `Number(...)` and
 * validates with `Number.isFinite`.
 */
export interface NseFiiDiiRow {
  category: 'FII/FPI' | 'DII' | string;
  date: string;
  buyValue: string | number;
  sellValue: string | number;
  netValue: string | number;
}
