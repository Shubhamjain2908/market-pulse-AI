/**
 * Fetch + persist COMEX gold COT from CFTC disaggregated file. Fail-open.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { getDb } from '../db/connection.js';
import { insertCotGoldIgnore } from '../db/queries.js';
import { createHttpClient } from '../ingestors/base/http-client.js';
import { child } from '../logger.js';
import {
  CFTC_GOLD_DISAGG_URL,
  extractComexGoldFromDisaggFile,
  type ParsedCotGoldRow,
} from './gold-cot.js';

const log = child({ component: 'cot-gold-fetch' });

export interface FetchGoldCotResult {
  ok: boolean;
  inserted: boolean;
  row: ParsedCotGoldRow | null;
}

export async function fetchGoldCot(db: DatabaseType = getDb()): Promise<FetchGoldCotResult> {
  const client = createHttpClient({ name: 'cftc-cot-gold' });
  try {
    await client.acquire();
    const body = await client.got(CFTC_GOLD_DISAGG_URL).text();
    const parsed = extractComexGoldFromDisaggFile(body);
    if (!parsed) {
      log.warn('CFTC disaggregated file had no COMEX GOLD row');
      return { ok: false, inserted: false, row: null };
    }

    const ingestedAt = new Date().toISOString();
    const inserted = insertCotGoldIgnore(
      {
        reportDate: parsed.reportDate,
        mmLong: parsed.mmLong,
        mmShort: parsed.mmShort,
        mmNet: parsed.mmNet,
        openInterest: parsed.openInterest,
        mmNetOiRatio: parsed.mmNetOiRatio,
        ingestedAt,
      },
      db,
    );

    log.info(
      {
        reportDate: parsed.reportDate,
        mmNet: parsed.mmNet,
        mmNetOiRatio: parsed.mmNetOiRatio,
        classification: parsed.classification,
        inserted,
      },
      'COMEX gold COT ingest complete',
    );
    return { ok: true, inserted, row: parsed };
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'CFTC gold COT fetch failed; skipping');
    return { ok: false, inserted: false, row: null };
  }
}
