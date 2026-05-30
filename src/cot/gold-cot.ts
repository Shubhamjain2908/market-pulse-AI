/**
 * COMEX gold row from CFTC disaggregated futures file (`f_disagg.txt`).
 * Managed-money columns are the disaggregated analogue to legacy non-commercial.
 */

export const CFTC_GOLD_DISAGG_URL = 'https://www.cftc.gov/dea/newcot/f_disagg.txt';

/** 0-based column indices (CFTC disaggregated futures-only layout). */
export const COT_DISAGG_COL = {
  marketName: 0,
  reportDate: 2,
  openInterestAll: 7,
  /** Legacy NonComm proxy on disaggregated reports. */
  mmLong: 13,
  mmShort: 14,
  /** CFTC quotes exchange code — COMEX gold is `CMX`. */
  exchangeCode: 187,
} as const;

export const COT_GOLD_CROWDED_LONG_RATIO = 0.35;
export const COT_GOLD_CROWDED_SHORT_RATIO = 0.1;

export type CotGoldClassification = 'CROWDED_LONG' | 'CROWDED_SHORT' | 'NEUTRAL';

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

function parseIntField(raw: string | undefined): number | null {
  if (raw == null || raw === '' || raw === '.') return null;
  const n = Number.parseInt(raw.replace(/\s+/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

export function isComexGoldRow(cols: string[]): boolean {
  const market = cols[COT_DISAGG_COL.marketName]?.toUpperCase() ?? '';
  const exchange = cols[COT_DISAGG_COL.exchangeCode]?.trim().toUpperCase() ?? '';
  if (!market.includes('GOLD')) return false;
  if (market.includes('MICRO')) return false;
  if (exchange === 'CMX' || exchange === 'COMEX') return true;
  return market.includes('COMMODITY EXCHANGE INC.');
}

export function computeMmNetOiRatio(mmNet: number, openInterest: number): number {
  if (openInterest <= 0) return 0;
  return mmNet / openInterest;
}

export function classifyCotGoldRatio(mmNetOiRatio: number): CotGoldClassification {
  if (mmNetOiRatio > COT_GOLD_CROWDED_LONG_RATIO) return 'CROWDED_LONG';
  if (mmNetOiRatio < COT_GOLD_CROWDED_SHORT_RATIO) return 'CROWDED_SHORT';
  return 'NEUTRAL';
}

export function parseCotGoldRow(cols: string[]): ParsedCotGoldRow | null {
  if (!isComexGoldRow(cols)) return null;

  const reportDate = cols[COT_DISAGG_COL.reportDate]?.trim() ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) return null;

  const mmLong = parseIntField(cols[COT_DISAGG_COL.mmLong]);
  const mmShort = parseIntField(cols[COT_DISAGG_COL.mmShort]);
  const openInterest = parseIntField(cols[COT_DISAGG_COL.openInterestAll]);
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
    classification: classifyCotGoldRatio(mmNetOiRatio),
  };
}

/** Parse file body; returns the COMEX gold row if present (first matching line). */
export function extractComexGoldFromDisaggFile(body: string): ParsedCotGoldRow | null {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = parseCsvLine(trimmed);
    const row = parseCotGoldRow(cols);
    if (row) return row;
  }
  return null;
}
