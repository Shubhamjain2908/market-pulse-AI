/**
 * NSE promoter pledge ingest — fail-open, once per trading day.
 * Fetches `/api/corporate-pledgedata?index=equities`, resolves `comName` → symbol
 * via `symbols.name`, persists `promoter_pledge`.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { z } from 'zod';
import { RATE_LIMITS } from '../../constants.js';
import { getDb } from '../../db/connection.js';
import {
  buildNameToSymbolMap,
  normalizeCompanyName,
  type PromoterPledgeRow,
  upsertPromoterPledgeRows,
} from '../../db/queries.js';
import { child } from '../../logger.js';
import { isoDateIst } from '../base/dates.js';
import { createHttpClient, type HttpClient } from '../base/http-client.js';
import { toFiniteNumber } from '../yahoo-snapshot-ingestor.js';
import { primeNseCookies } from './cookie-jar.js';

const log = child({ component: 'pledge-fetcher' });

const NSE_PLEDGE_API = 'https://www.nseindia.com/api/corporate-pledgedata?index=equities';
const PLEDGE_REFERER =
  'https://www.nseindia.com/companies-listing/corporate-filings-shareholding-pattern';

const API_HEADERS = {
  accept: '*/*',
  referer: PLEDGE_REFERER,
  origin: 'https://www.nseindia.com',
  'x-requested-with': 'XMLHttpRequest',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
} as const;

const NsePledgeEnvelopeSchema = z.union([
  z.array(z.unknown()),
  z.object({ data: z.array(z.unknown()) }).passthrough(),
]);

export type NsePledgeRowInput = {
  comName: string;
  percSharesPledged?: unknown;
  percPromoterHolding?: unknown;
  numSharesPledged?: unknown;
  shp?: unknown;
};

function parsePaddedNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return null;
    const n = Number.parseFloat(t);
    return Number.isFinite(n) ? n : null;
  }
  return toFiniteNumber(v);
}

/** NSE sends dates like `30-Jun-2026` or ISO; normalize to YYYY-MM-DD. */
export function parseNseShpDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(t);
  if (!m) return null;
  const months: Record<string, string> = {
    jan: '01',
    feb: '02',
    mar: '03',
    apr: '04',
    may: '05',
    jun: '06',
    jul: '07',
    aug: '08',
    sep: '09',
    oct: '10',
    nov: '11',
    dec: '12',
  };
  const mm = months[m[2]?.toLowerCase() ?? ''];
  if (!mm) return null;
  const dd = (m[1] ?? '').padStart(2, '0');
  return `${m[3]}-${mm}-${dd}`;
}

function toNsePledgeRowInput(item: unknown): NsePledgeRowInput | null {
  if (!item || typeof item !== 'object') return null;
  const rec = item as Record<string, unknown>;
  if (typeof rec.comName !== 'string') return null;
  const comName = rec.comName.trim();
  if (!comName) return null;
  return {
    comName,
    percSharesPledged: rec.percSharesPledged,
    percPromoterHolding: rec.percPromoterHolding,
    numSharesPledged: rec.numSharesPledged,
    shp: rec.shp,
  };
}

export function parseNsePledgeApiResponse(raw: unknown): NsePledgeRowInput[] | null {
  const parsed = NsePledgeEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return null;
  const items = Array.isArray(parsed.data) ? parsed.data : parsed.data.data;
  const rows: NsePledgeRowInput[] = [];
  for (const item of items) {
    const row = toNsePledgeRowInput(item);
    if (row) rows.push(row);
  }
  return rows;
}

export function mapNsePledgeRows(
  rows: NsePledgeRowInput[],
  nameToSymbol: Map<string, string>,
): { mapped: PromoterPledgeRow[]; unmatched: string[] } {
  const mapped: PromoterPledgeRow[] = [];
  const unmatched: string[] = [];

  for (const row of rows) {
    const key = normalizeCompanyName(row.comName);
    const symbol = key ? nameToSymbol.get(key) : undefined;
    if (!symbol) {
      unmatched.push(row.comName);
      continue;
    }
    const shpDate = parseNseShpDate(row.shp);
    if (!shpDate) continue;

    mapped.push({
      symbol,
      shpDate,
      pctSharesPledged: parsePaddedNumber(row.percSharesPledged),
      pctPromoterHolding: parsePaddedNumber(row.percPromoterHolding),
      numSharesPledged: parsePaddedNumber(row.numSharesPledged),
      source: 'nse',
    });
  }

  return { mapped, unmatched };
}

export interface FetchPromoterPledgeOptions {
  date?: string;
  db?: DatabaseType;
  signal?: AbortSignal;
  client?: HttpClient;
}

export interface FetchPromoterPledgeResult {
  date: string;
  attempted: number;
  written: number;
  unmatched: number;
  failed: boolean;
}

export async function fetchPromoterPledge(
  opts: FetchPromoterPledgeOptions = {},
): Promise<FetchPromoterPledgeResult> {
  const date = opts.date ?? isoDateIst();
  const db = opts.db ?? getDb();

  const client =
    opts.client ??
    createHttpClient({
      name: 'nse-pledge',
      rateLimit: { requestsPerSecond: RATE_LIMITS.nse, burst: 2 },
      withCookieJar: true,
    });

  try {
    await primeNseCookies(client, opts.signal);
    const raw = await client.request<unknown>(NSE_PLEDGE_API, {
      signal: opts.signal,
      headers: API_HEADERS,
    });

    const rows = parseNsePledgeApiResponse(raw);
    if (!rows) {
      log.warn(
        { preview: JSON.stringify(raw).slice(0, 300) },
        'nse pledge response failed validation',
      );
      return { date, attempted: 0, written: 0, unmatched: 0, failed: true };
    }

    const nameToSymbol = buildNameToSymbolMap(db);
    const { mapped, unmatched } = mapNsePledgeRows(rows, nameToSymbol);
    const written = upsertPromoterPledgeRows(mapped, db);

    if (unmatched.length > 0) {
      log.info(
        {
          unmatchedCount: unmatched.length,
          sample: unmatched.slice(0, 5),
        },
        'pledge ingest: unmatched comName rows',
      );
    }

    log.info(
      { date, attempted: rows.length, written, unmatched: unmatched.length },
      'promoter pledge ingest complete',
    );
    return { date, attempted: rows.length, written, unmatched: unmatched.length, failed: false };
  } catch (err) {
    log.warn({ err: (err as Error).message, date }, 'nse pledge fetch failed; skipping');
    return { date, attempted: 0, written: 0, unmatched: 0, failed: true };
  }
}
