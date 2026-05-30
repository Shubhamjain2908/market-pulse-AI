/**
 * COMEX gold row from CFTC disaggregated futures file (`f_disagg.txt`).
 * Managed-money columns are the disaggregated analogue to legacy non-commercial.
 * Columns are resolved by header name (embedded CFTC spec when the file has no header row).
 */

import {
  DISAGG_FUTURES_ONLY_COLUMN_COUNT,
  DISAGG_FUTURES_ONLY_COLUMN_NAMES,
} from './disagg-futures-headers.js';

export const CFTC_GOLD_DISAGG_URL = 'https://www.cftc.gov/dea/newcot/f_disagg.txt';

/** CFTC field names used for COMEX gold parsing (CFTC_023168). */
export const COT_GOLD_FIELDS = {
  marketName: 'Market_and_Exchange_Names',
  reportDate: 'As_of_Date_Form_YYYY-MM-DD',
  openInterestAll: 'Open_Interest_All',
  mmLong: 'M_Money_Positions_Long_All',
  mmShort: 'M_Money_Positions_Short_All',
  /** COMEX gold is `CMX` (field 188 / CFTC_Market_Code_Quotes). */
  exchangeCodeQuotes: 'CFTC_Market_Code_Quotes',
} as const;

export const COT_GOLD_REQUIRED_FIELD_NAMES: readonly string[] = Object.values(COT_GOLD_FIELDS);

export const COT_GOLD_CROWDED_LONG_RATIO = 0.35;

export type CotGoldClassification = 'CROWDED_LONG' | 'CROWDED_SHORT' | 'NEUTRAL';

export type DisaggColumnMap = ReadonlyMap<string, number>;

export interface ParsedCotGoldRow {
  reportDate: string;
  mmLong: number;
  mmShort: number;
  mmNet: number;
  openInterest: number;
  mmNetOiRatio: number;
  classification: CotGoldClassification;
}

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function isHeaderRow(cols: string[]): boolean {
  return cols.some((c) => c.trim() === COT_GOLD_FIELDS.marketName);
}

export function buildDisaggColumnMap(firstRowCols: string[]): DisaggColumnMap | null {
  const headerNames = isHeaderRow(firstRowCols)
    ? firstRowCols.map((c) => c.trim())
    : [...DISAGG_FUTURES_ONLY_COLUMN_NAMES];

  if (!isHeaderRow(firstRowCols) && firstRowCols.length !== DISAGG_FUTURES_ONLY_COLUMN_COUNT) {
    return null;
  }

  const map = new Map<string, number>();
  for (let i = 0; i < headerNames.length; i++) {
    const name = headerNames[i]?.trim();
    if (name) map.set(name, i);
  }

  for (const required of COT_GOLD_REQUIRED_FIELD_NAMES) {
    if (!map.has(required)) return null;
  }

  return map;
}

function colValue(cols: string[], map: DisaggColumnMap, field: string): string | undefined {
  const idx = map.get(field);
  if (idx == null) return undefined;
  return cols[idx];
}

function parseIntField(raw: string | undefined): number | null {
  if (raw == null || raw === '' || raw === '.') return null;
  const n = Number.parseInt(raw.replace(/\s+/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

export function isComexGoldRow(cols: string[], map: DisaggColumnMap): boolean {
  const market = colValue(cols, map, COT_GOLD_FIELDS.marketName)?.toUpperCase() ?? '';
  const exchange =
    colValue(cols, map, COT_GOLD_FIELDS.exchangeCodeQuotes)?.trim().toUpperCase() ?? '';
  if (!market.includes('GOLD')) return false;
  if (market.includes('MICRO')) return false;
  if (exchange === 'CMX' || exchange === 'COMEX') return true;
  return market.includes('COMMODITY EXCHANGE INC.');
}

export function computeMmNetOiRatio(mmNet: number, openInterest: number): number {
  if (openInterest <= 0) return 0;
  return mmNet / openInterest;
}

/** Crowded long by net/OI; crowded short only when managed money is net short. */
export function classifyCotGoldPosition(
  mmNet: number,
  mmNetOiRatio: number,
): CotGoldClassification {
  if (mmNetOiRatio > COT_GOLD_CROWDED_LONG_RATIO) return 'CROWDED_LONG';
  if (mmNet < 0) return 'CROWDED_SHORT';
  return 'NEUTRAL';
}

export function parseCotGoldRow(cols: string[], map: DisaggColumnMap): ParsedCotGoldRow | null {
  if (cols.length !== map.size) return null;
  if (!isComexGoldRow(cols, map)) return null;

  const reportDate = colValue(cols, map, COT_GOLD_FIELDS.reportDate)?.trim() ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) return null;

  const mmLong = parseIntField(colValue(cols, map, COT_GOLD_FIELDS.mmLong));
  const mmShort = parseIntField(colValue(cols, map, COT_GOLD_FIELDS.mmShort));
  const openInterest = parseIntField(colValue(cols, map, COT_GOLD_FIELDS.openInterestAll));
  if (mmLong == null || mmShort == null || openInterest == null) return null;

  const mmNet = mmLong - mmShort;
  const mmNetOiRatio = computeMmNetOiRatio(mmNet, openInterest);
  return {
    reportDate,
    mmLong,
    mmShort,
    mmNet,
    openInterest,
    mmNetOiRatio,
    classification: classifyCotGoldPosition(mmNet, mmNetOiRatio),
  };
}

/** Parse file body; returns the COMEX gold row if present (first matching line). */
export function extractComexGoldFromDisaggFile(body: string): ParsedCotGoldRow | null {
  const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  const firstLine = lines[0];
  if (!firstLine) return null;
  const firstCols = parseCsvLine(firstLine);
  const map = buildDisaggColumnMap(firstCols);
  if (!map) return null;

  const dataLines = isHeaderRow(firstCols) ? lines.slice(1) : lines;
  const expectedWidth = map.size;

  for (const line of dataLines) {
    const cols = parseCsvLine(line);
    if (cols.length !== expectedWidth) continue;
    const row = parseCotGoldRow(cols, map);
    if (row) return row;
  }
  return null;
}
