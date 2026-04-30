/**
 * Provider-agnostic Ingestor contract. Every data source (NSE, Yahoo,
 * Screener, Kite, ...) implements a subset of this surface so the pipeline
 * can mix-and-match without changes downstream.
 *
 * Note: not every method is required. A news-only source can implement
 * `fetchNews` and leave the rest as `undefined`.
 */

import type { FiiDiiRow, Fundamentals, NewsItem, RawQuote } from '../types/domain.js';

export interface IngestorContext {
  /** ISO date (YYYY-MM-DD) the pipeline is targeting. Default: today, IST. */
  date?: string;
  /** Universe of symbols the caller cares about. */
  symbols?: string[];
  /** Optional abort signal, used by the CLI on Ctrl+C. */
  signal?: AbortSignal;
}

export interface IngestResult<T> {
  data: T[];
  /** Symbols (or feeds) we couldn't fetch. Logged but non-fatal. */
  failed: string[];
  /** Provider name, useful for breadcrumbs. */
  source: string;
}

export interface Ingestor {
  /** Stable id, e.g. 'nse-eod' or 'kite-tick'. */
  readonly name: string;

  /** The kinds of data this ingestor can produce. */
  readonly capabilities: ReadonlySet<IngestorCapability>;

  /** Lazy initialisation - cookie warm-up, login, etc. Called once per run. */
  init?(ctx: IngestorContext): Promise<void>;

  fetchQuotes?(ctx: IngestorContext): Promise<IngestResult<RawQuote>>;
  fetchFundamentals?(ctx: IngestorContext): Promise<IngestResult<Fundamentals>>;
  fetchNews?(ctx: IngestorContext): Promise<IngestResult<NewsItem>>;
  fetchFiiDii?(ctx: IngestorContext): Promise<IngestResult<FiiDiiRow>>;
}

export type IngestorCapability = 'quotes' | 'fundamentals' | 'news' | 'fii_dii';
