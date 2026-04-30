/**
 * Subset of the NSE response shapes we depend on. The actual payloads are
 * much larger; we model only the fields we read.
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

export interface NseFiiDiiRow {
  /** Category - 'FII/FPI ' or 'DII ' (with trailing space, sigh). */
  category: string;
  date: string;
  buyValue: number;
  sellValue: number;
  netValue: number;
}
