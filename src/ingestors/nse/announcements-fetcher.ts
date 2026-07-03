/**
 * NSE corporate announcements fetcher — concall transcript ingest.
 * Mirrors `pledge-fetcher.ts` pattern (cookie-jar prime via `primeNseCookies`,
 * zod envelope, never-throws, fail-open `warn`, result counters).
 *
 * Universe: holdings ∪ open paper-trade symbols ∪ watchlist.
 * One API call per symbol with bounded date range.
 * Filters rows for concall transcripts, downloads PDFs, extracts text via `unpdf`.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { z } from 'zod';
import { RATE_LIMITS } from '../../constants.js';
import { getDb } from '../../db/connection.js';
import { getDistinctOpenPaperTradeSymbols, insertConcallTranscript } from '../../db/queries.js';
import { getLatestHoldings } from '../../db/portfolio-queries.js';
import { loadWatchlist } from '../../config/loaders.js';
import { child } from '../../logger.js';
import { isoDateIst } from '../base/dates.js';
import { createHttpClient, type HttpClient } from '../base/http-client.js';
import { primeNseCookies } from './cookie-jar.js';

const log = child({ component: 'announcements-fetcher' });

const NSE_ANNOUNCEMENTS_API =
  'https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=';

const ANNOUNCEMENT_REFERER =
  'https://www.nseindia.com/companies-listing/corporate-filings-announcements';

const API_HEADERS = {
  accept: '*/*',
  referer: ANNOUNCEMENT_REFERER,
  origin: 'https://www.nseindia.com',
  'x-requested-with': 'XMLHttpRequest',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
} as const;

const NseAnnouncementItemSchema = z.object({
  an_dt: z.string().optional(),
  desc: z.string().optional(),
  attchmntFile: z.string().optional(),
  attchmntText: z.string().optional(),
});

const NseAnnouncementsEnvelopeSchema = z.union([
  z.array(NseAnnouncementItemSchema),
  z.object({ data: z.array(NseAnnouncementItemSchema) }).passthrough(),
]);

/** Normalise NSE date format `DD-MMM-YYYY` or `YYYY-MM-DD` to ISO. */
function parseNseDate(raw: string): string | null {
  const t = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(t);
  if (!m) return null;
  const months: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };
  const mm = months[m[2]?.toLowerCase() ?? ''];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[1] ?? ''}`;
}

function classifyTranscriptKind(
  attchmntFile: string | undefined,
  attchmntText: string | undefined,
): 'transcript' | 'invite' | null {
  const file = (attchmntFile ?? '').toLowerCase();
  const text = (attchmntText ?? '').toLowerCase();
  const isPdf = file.endsWith('.pdf');
  const isTranscript = /\btranscript\b/i.test(file) || /\btranscript\b/i.test(text);
  if (isPdf && isTranscript) return 'transcript';
  if (isPdf) return 'invite';
  return null;
}

export interface FetchAnnouncementsOptions {
  date?: string;
  db?: DatabaseType;
  signal?: AbortSignal;
  client?: HttpClient;
  /** Override universe (default: holdings ∪ open paper trades ∪ watchlist). */
  symbols?: string[];
  /** Window days before `date` to fetch. Default 10. */
  lookbackDays?: number;
}

export interface FetchAnnouncementsResult {
  date: string;
  symbolsChecked: number;
  transcriptsFound: number;
  downloaded: number;
  extracted: number;
  failed: number;
  skipped: number;
}

/**
 * Fetch NSE corporate announcements for the configured universe,
 * filter to concall transcripts, download PDFs, extract text, persist.
 * Never throws — returns result counters on any failure.
 */
export async function fetchConcallTranscripts(
  opts: FetchAnnouncementsOptions = {},
): Promise<FetchAnnouncementsResult> {
  const date = opts.date ?? isoDateIst();
  const db = opts.db ?? getDb();
  const lookbackDays = opts.lookbackDays ?? 10;

  const client =
    opts.client ??
    createHttpClient({
      name: 'nse-announcements',
      rateLimit: { requestsPerSecond: RATE_LIMITS.nse, burst: 2 },
      withCookieJar: true,
    });

  // Resolve universe
  const symbols = opts.symbols ?? resolveConcallUniverse(db);
  if (symbols.length === 0) {
    log.info({ date }, 'no symbols in concall universe — skipping');
    return { date, symbolsChecked: 0, transcriptsFound: 0, downloaded: 0, extracted: 0, failed: 0, skipped: 0 };
  }

  const fromDate = (() => {
    const d = new Date(`${date}T00:00:00+05:30`);
    d.setDate(d.getDate() - lookbackDays);
    return d.toLocaleDateString('sv-SE');
  })();

  const result: FetchAnnouncementsResult = {
    date,
    symbolsChecked: 0,
    transcriptsFound: 0,
    downloaded: 0,
    extracted: 0,
    failed: 0,
    skipped: 0,
  };

  try {
    await primeNseCookies(client, opts.signal);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'nse cookie prime failed; skipping concall fetch');
    result.failed = symbols.length;
    return result;
  }

  for (const symbol of symbols) {
    result.symbolsChecked++;
    try {
      const url = `${NSE_ANNOUNCEMENTS_API}${encodeURIComponent(symbol)}&from_date=${fromDate}&to_date=${date}`;
      const raw = await client.request<unknown>(url, {
        signal: opts.signal,
        headers: API_HEADERS,
      });

      const parsed = NseAnnouncementsEnvelopeSchema.safeParse(raw);
      if (!parsed.success) {
        log.warn({ symbol, preview: JSON.stringify(raw).slice(0, 200) }, 'announcements response failed validation');
        result.failed++;
        continue;
      }

      // Normalize: union returns either array (direct) or { data: [...] }
      const rawData = parsed.data;
      const rows: Array<z.infer<typeof NseAnnouncementItemSchema>> = Array.isArray(rawData)
        ? rawData
        : (rawData as { data: Array<z.infer<typeof NseAnnouncementItemSchema>> }).data;
      let symbolTranscripts = 0;

      for (const item of rows) {
        const desc = (item.desc ?? '').toLowerCase();
        // Filter to concall-related announcements
        if (!/\b(analysts|institutional investor|conference|con.?call|meet)\b/i.test(desc)) continue;
        if (!/\b(updates?|meet|call|transcript)\b/i.test(desc)) continue;

        const kind = classifyTranscriptKind(item.attchmntFile, item.attchmntText);
        if (!kind) continue;

        const announcedAt = item.an_dt ? parseNseDate(item.an_dt) : null;
        const attachmentUrl = item.attchmntFile?.trim();
        if (!announcedAt || !attachmentUrl) continue;

        result.transcriptsFound++;
        symbolTranscripts++;

        // Build full PDF URL
        const pdfUrl = attachmentUrl.startsWith('http')
          ? attachmentUrl
          : `https://nsearchives.nseindia.com${attachmentUrl.startsWith('/') ? '' : '/'}${attachmentUrl}`;

        // Download and extract PDF
        try {
          const pdfBuf = await client.got(pdfUrl, {
            signal: opts.signal,
            responseType: 'buffer',
            timeout: { request: 30_000 },
          }).buffer();

          const text = await extractPdfText(pdfBuf);
          const charCount = text.length;

          if (charCount < 2000) {
            log.warn({ symbol, charCount, url: pdfUrl }, 'transcript PDF too short — skipping (likely image-only)');
            result.skipped++;
            continue;
          }

          const inserted = insertConcallTranscript(
            {
              symbol,
              announcedAt,
              attachmentUrl: pdfUrl,
              kind,
              text,
              charCount,
            },
            db,
          );

          if (inserted) {
            result.downloaded++;
            result.extracted++;
          } else {
            result.skipped++;
          }
        } catch (err) {
          log.warn({ symbol, url: pdfUrl, err: (err as Error).message }, 'transcript PDF download/extract failed');
          result.failed++;
        }

        // Rate limit between symbols
        await client.acquire(opts.signal);
      }

      if (symbolTranscripts > 0) {
        log.info({ symbol, transcripts: symbolTranscripts }, 'concall transcripts found for symbol');
      }
    } catch (err) {
      log.warn({ symbol, err: (err as Error).message }, 'announcements fetch failed for symbol');
      result.failed++;
    }
  }

  log.info(
    {
      date,
      symbolsChecked: result.symbolsChecked,
      transcriptsFound: result.transcriptsFound,
      downloaded: result.downloaded,
      extracted: result.extracted,
      failed: result.failed,
      skipped: result.skipped,
    },
    'concall transcript fetch complete',
  );
  return result;
}

/**
 * Resolve universe for concall fetching: holdings ∪ open paper trades ∪ watchlist.
 * Symbols are merged and deduped.
 */
export function resolveConcallUniverse(db: DatabaseType): string[] {
  const set = new Set<string>();

  // Add holdings
  for (const h of getLatestHoldings(db)) {
    set.add(h.symbol.toUpperCase());
  }

  // Add open paper trades
  for (const s of getDistinctOpenPaperTradeSymbols(db)) {
    set.add(s.toUpperCase());
  }

  // Add watchlist
  try {
    for (const s of loadWatchlist().symbols) {
      set.add(s.toUpperCase());
    }
  } catch {
    // Watchlist may not be configured
  }

  return [...set].sort();
}

/**
 * Extract text from a PDF buffer using `unpdf`.
 * Falls back to empty string on any extraction error.
 */
async function extractPdfText(buf: Uint8Array | Buffer): Promise<string> {
  try {
    const { getDocumentProxy, extractText } = await import('unpdf');
    const pdf = getDocumentProxy(buf);
    const { text } = await extractText(pdf, { mergePages: true });
    return (text ?? '').trim();
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'PDF text extraction failed');
    return '';
  }
}
