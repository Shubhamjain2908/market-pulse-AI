/**
 * Context provenance — collects data-as-of timestamps for every DB source
 * used by `buildStockContext` and thesis generation. Persisted to
 * `theses.context_refs` JSON for briefing provenance blocks.
 *
 * Task C: buildContextProvenance
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { getDb } from '../db/index.js';

/**
 * Shape of the provenance JSON stored in `theses.context_refs`.
 * Mirrors the migration 0027 comment.
 */
export interface ContextRefs {
  quotes: { from: string; to: string; bars: number; source: string };
  fundamentals: { asOf: string; source: string; stale: boolean } | null;
  quarterly: { quarters: string[]; source: string } | null;
  signals: { count: number; latestDate: string };
  news: Array<{ headline: string; url: string; publishedAt: string }>;
  concall: { announcedAt: string; pdfUrl: string } | null;
  pledge: { shpDate: string } | null;
}

/**
 * Collects data provenance for a symbol as of a given date.
 * Returns a JSON-serialisable `ContextRefs` object suitable for
 * `theses.context_refs`.
 */
export function buildContextProvenance(
  symbol: string,
  date: string,
  db: DatabaseType = getDb(),
): ContextRefs {
  const sym = symbol.toUpperCase();

  // Quotes: date range of the last 20 bars used by buildStockContext
  const quoteRows = db
    .prepare(
      `      SELECT date FROM quotes
       WHERE symbol = ? AND date <= ?
       ORDER BY date DESC LIMIT 20`,
    )
    .all(sym, date) as Array<{ date: string }>;
  const quotes: ContextRefs['quotes'] =
    quoteRows.length > 0
      ? {
          // biome-ignore lint/style/noNonNullAssertion: guarded by .length > 0
          from: quoteRows[quoteRows.length - 1]!.date,
          // biome-ignore lint/style/noNonNullAssertion: guarded by .length > 0
          to: quoteRows[0]!.date,
          bars: quoteRows.length,
          source: 'NSE',
        }
      : { from: '', to: '', bars: 0, source: 'NSE' };

  // Fundamentals: latest row and source
  const fundaRow = db
    .prepare(
      `SELECT as_of AS asOf, source FROM fundamentals
       WHERE symbol = ? ORDER BY as_of DESC LIMIT 1`,
    )
    .get(sym) as { asOf: string; source: string } | undefined;
  const fundamentalsStale = fundaRow != null ? fundaRow.asOf < `${date.slice(0, 7)}-01` : false;
  const fundamentals: ContextRefs['fundamentals'] = fundaRow
    ? { asOf: fundaRow.asOf, source: fundaRow.source, stale: fundamentalsStale }
    : null;

  // Quarterly fundamentals: most recent quarters
  const quarterRows = db
    .prepare(
      `SELECT quarter_end AS quarterEnd, source FROM quarterly_fundamentals
       WHERE symbol = ? AND quarter_end <= ?
       ORDER BY quarter_end DESC LIMIT 4`,
    )
    .all(sym, date) as Array<{ quarterEnd: string; source: string }>;
  const quarterly: ContextRefs['quarterly'] =
    quarterRows.length > 0
      ? {
          quarters: quarterRows.map((r) => r.quarterEnd),
          // biome-ignore lint/style/noNonNullAssertion: guarded by .length > 0
          source: quarterRows[0]!.source,
        }
      : null;

  // Signals: count and latest date
  const signalRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt, MAX(date) AS latestDate
       FROM signals WHERE symbol = ? AND date <= ?`,
    )
    .get(sym, date) as { cnt: number; latestDate: string | null };
  const signals: ContextRefs['signals'] = {
    count: signalRow?.cnt ?? 0,
    latestDate: signalRow?.latestDate ?? '',
  };

  // News: last 7 days' headlines used by buildStockContext
  const newsRows = db
    .prepare(
      `SELECT headline, url, published_at AS publishedAt
       FROM news
       WHERE (symbol = ? OR symbol IS NULL)
         AND published_at >= datetime(?, '-7 days')
       ORDER BY published_at DESC LIMIT 10`,
    )
    .all(sym, date) as Array<{ headline: string; url: string; publishedAt: string }>;
  const news: ContextRefs['news'] = newsRows.map((r) => ({
    headline: r.headline,
    url: r.url,
    publishedAt: r.publishedAt,
  }));

  // Concall intel: latest analysed transcript (strictly prior, max 90 days lookback)
  const concallRow = db
    .prepare(
      `SELECT ci.announced_at AS announcedAt, ct.attachment_url AS pdfUrl
       FROM concall_intel ci
       LEFT JOIN concall_transcripts ct
         ON ci.symbol = ct.symbol AND ci.announced_at = ct.announced_at
       WHERE ci.symbol = ? AND ci.announced_at < ? AND ci.announced_at >= date(?, '-90 days')
       ORDER BY ci.announced_at DESC LIMIT 1`,
    )
    .get(sym, date, date) as { announcedAt: string; pdfUrl: string | null } | undefined;
  const concall: ContextRefs['concall'] = concallRow
    ? { announcedAt: concallRow.announcedAt, pdfUrl: concallRow.pdfUrl ?? '' }
    : null;

  // Promoter pledge: latest snapshot
  const pledgeRow = db
    .prepare(
      `SELECT shp_date AS shpDate FROM promoter_pledge
       WHERE symbol = ? AND shp_date <= ?
       ORDER BY shp_date DESC LIMIT 1`,
    )
    .get(sym, date) as { shpDate: string } | undefined;
  const pledge: ContextRefs['pledge'] = pledgeRow ? { shpDate: pledgeRow.shpDate } : null;

  return { quotes, fundamentals, quarterly, signals, news, concall, pledge };
}
