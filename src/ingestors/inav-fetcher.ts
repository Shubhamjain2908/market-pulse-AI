/**
 * NSE ETF iNAV snapshot ingest — fail-open, once per trading day.
 * Fetches `/api/etf`, filters to `config/etf-exclusions.json` universe, persists
 * `inav_snapshots` for premium/discount briefing alerts.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { z } from 'zod';
import { loadEtfExclusions } from '../config/loaders.js';
import { RATE_LIMITS } from '../constants.js';
import { getDb } from '../db/connection.js';
import { type InavSnapshotRow, upsertInavSnapshots } from '../db/queries.js';
import { child } from '../logger.js';
import { isoDateIst } from './base/dates.js';
import { createHttpClient, type HttpClient } from './base/http-client.js';
import { primeNseCookies } from './nse/cookie-jar.js';
import { toFiniteNumber } from './yahoo-snapshot-ingestor.js';

const log = child({ component: 'inav-fetcher' });

const NSE_ETF_API = 'https://www.nseindia.com/api/etf';
const ETF_REFERER = 'https://www.nseindia.com/market-data/etf';

const API_HEADERS = {
  accept: '*/*',
  referer: ETF_REFERER,
  origin: 'https://www.nseindia.com',
  'x-requested-with': 'XMLHttpRequest',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
} as const;

const NseEtfRowSchema = z.object({
  symbol: z.string(),
  navValue: z.union([z.string(), z.number()]),
  lastPrice: z.union([z.string(), z.number()]),
});

const NseEtfResponseSchema = z.union([
  z.array(NseEtfRowSchema),
  z.object({ data: z.array(NseEtfRowSchema) }),
]);

export interface FetchInavSnapshotsOptions {
  date?: string;
  db?: DatabaseType;
  signal?: AbortSignal;
  /** Inject client for tests. */
  client?: HttpClient;
}

export interface FetchInavSnapshotsResult {
  date: string;
  attempted: number;
  written: number;
  skipped: number;
  failed: boolean;
}

export function computePremiumDiscountPct(inav: number, lastPrice: number): number {
  if (inav <= 0) return 0;
  return ((lastPrice - inav) / inav) * 100;
}

export function mapNseEtfRows(
  rows: Array<{ symbol: string; navValue: unknown; lastPrice: unknown }>,
  universe: ReadonlySet<string>,
  date: string,
): InavSnapshotRow[] {
  const capturedAt = new Date().toISOString();
  const out: InavSnapshotRow[] = [];

  for (const row of rows) {
    const symbol = row.symbol.trim().toUpperCase();
    if (!universe.has(symbol)) continue;

    const inav = toFiniteNumber(row.navValue);
    const lastPrice = toFiniteNumber(row.lastPrice);
    if (inav == null || lastPrice == null || inav <= 0) continue;

    out.push({
      symbol,
      date,
      inav,
      lastPrice,
      premiumDiscountPct: computePremiumDiscountPct(inav, lastPrice),
      capturedAt,
    });
  }

  return out;
}

/**
 * Fetch NSE ETF iNAV table and upsert snapshots for the configured ETF universe.
 * Never throws — returns `{ failed: true }` on endpoint/validation errors.
 */
export async function fetchInavSnapshots(
  opts: FetchInavSnapshotsOptions = {},
): Promise<FetchInavSnapshotsResult> {
  const date = opts.date ?? isoDateIst();
  const db = opts.db ?? getDb();
  const universe = new Set(loadEtfExclusions().map((s) => s.toUpperCase()));
  const attempted = universe.size;

  if (universe.size === 0) {
    return { date, attempted: 0, written: 0, skipped: 0, failed: false };
  }

  // TODO: reuse NseIngestor's primed HttpClient (see src/ingestors/nse/ingestor.ts) to avoid a
  // second primeNseCookies handshake per daily run. Safe to defer — once-daily, per-IP soft limits.
  const client =
    opts.client ??
    createHttpClient({
      name: 'nse-inav',
      rateLimit: { requestsPerSecond: RATE_LIMITS.nse, burst: 2 },
      withCookieJar: true,
    });

  try {
    await primeNseCookies(client, opts.signal);
    const raw = await client.request<unknown>(NSE_ETF_API, {
      signal: opts.signal,
      headers: API_HEADERS,
    });

    const parsed = NseEtfResponseSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn(
        { issues: parsed.error.issues.slice(0, 3), preview: JSON.stringify(raw).slice(0, 300) },
        'nse etf response failed validation',
      );
      return { date, attempted, written: 0, skipped: attempted, failed: true };
    }

    const rows = Array.isArray(parsed.data) ? parsed.data : parsed.data.data;
    const mapped = mapNseEtfRows(rows, universe, date);
    const written = upsertInavSnapshots(mapped, db);
    const skipped = attempted - written;

    log.info({ date, attempted, written, skipped }, 'inav snapshot ingest complete');
    return { date, attempted, written, skipped, failed: false };
  } catch (err) {
    log.warn({ err: (err as Error).message, date }, 'nse etf inav fetch failed; skipping');
    return { date, attempted, written: 0, skipped: attempted, failed: true };
  }
}
