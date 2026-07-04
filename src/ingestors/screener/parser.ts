/**
 * Cheerio-based parser for Screener.in company pages. The site renders
 * each ratio in a uniform `.company-ratios li` block:
 *
 *   <li class="flex flex-space-between">
 *     <span class="name">Stock P/E</span>
 *     <span class="nowrap value"><span class="number">28.4</span></span>
 *   </li>
 *
 * We extract by label match and parse the trailing number, tolerating
 * commas, units and leading/trailing whitespace.
 */

import type { CheerioAPI } from 'cheerio';
import { load } from 'cheerio';
import { child } from '../../logger.js';
import type { Fundamentals, QuarterlyFundamentals } from '../../types/domain.js';
import { isoDateIst } from '../base/dates.js';

const log = child({ component: 'screener-parser' });

export interface ParseScreenerOptions {
  symbol: string;
  asOf?: string;
  /** Set when calling - used in the resulting Fundamentals.source field. */
  source: string;
}

export function parseScreenerHtml(html: string, opts: ParseScreenerOptions): Fundamentals | null {
  const $ = load(html);
  const ratios = new Map<string, string>();

  $('.company-ratios li, #top-ratios li').each((_, el) => {
    const name = $(el).find('.name').first().text().trim();
    const value = $(el).find('.value, .number').first().text().trim();
    if (name) ratios.set(name.toLowerCase(), value);
  });

  log.debug({ symbol: opts.symbol, ratioKeys: [...ratios.keys()] }, 'screener ratio keys');

  if (ratios.size === 0) return null;

  let revenueGrowthYoY: number | undefined;
  let profitGrowthYoY: number | undefined;
  try {
    const g = parseGrowthFromRangesTables($);
    revenueGrowthYoY = g.revenue;
    profitGrowthYoY = g.profit;
  } catch (err) {
    log.debug({ symbol: opts.symbol, err }, 'screener ranges-table growth parse failed');
  }

  let promoterHoldingPct: number | undefined;
  let promoterHoldingChangeQoQ: number | undefined;
  try {
    const sh = parsePromoterShareholding($);
    promoterHoldingPct = sh.pct ?? parseFloatLoose(get(ratios, 'promoter holding'));
    promoterHoldingChangeQoQ = sh.changeQoQ;
  } catch (err) {
    log.debug({ symbol: opts.symbol, err }, 'screener shareholding parse failed');
    promoterHoldingPct = parseFloatLoose(get(ratios, 'promoter holding'));
  }

  // Screener.in shows "Book Value" (₹/share) and "Current Price" (₹/share) but
  // NOT "Price to Book Value" directly. Compute PB = Current Price / Book Value
  // when the ratio isn't present. Both are always available in the company-ratios.
  const currentPrice = parseFloatLoose(get(ratios, 'current price'));
  const bookValue = parseFloatLoose(get(ratios, 'book value'));
  const pbDirect = parseFloatLoose(get(ratios, 'price to book value', 'p/b'));
  const pb =
    pbDirect ??
    (currentPrice != null && bookValue != null && bookValue > 0
      ? Math.round((currentPrice / bookValue) * 100) / 100
      : undefined);

  let debtToEquity: number | undefined;
  try {
    debtToEquity =
      parseFloatLoose(get(ratios, 'debt / equity', 'debt to equity', 'd/e')) ??
      parseDebtToEquityFromDataTables($) ??
      // Screener.in balance sheet shows "Borrowings" as total debt and
      // "Equity Capital" + "Reserves" as total equity. Compute ratio when
      // direct labels are missing (common for most NSE listings).
      computeDebtToEquityFromBalanceSheet($);
  } catch (err) {
    log.debug({ symbol: opts.symbol, err }, 'screener debt/equity parse failed');
    debtToEquity = parseFloatLoose(get(ratios, 'debt / equity', 'debt to equity', 'd/e'));
  }

  return {
    symbol: opts.symbol.toUpperCase(),
    asOf: opts.asOf ?? isoDateIst(),
    marketCap: parseRupeeCrore(get(ratios, 'market cap')),
    pe: parseFloatLoose(get(ratios, 'stock p/e', 'p/e')),
    pb,
    peg: parseFloatLoose(get(ratios, 'peg ratio', 'peg')),
    roe: parseFloatLoose(get(ratios, 'roe', 'return on equity')),
    roce: parseFloatLoose(get(ratios, 'roce', 'return on capital employed')),
    revenueGrowthYoY,
    profitGrowthYoY,
    netProfitTtm: parseRupeeCrore(get(ratios, 'net profit', 'net profit ttm')),
    debtToEquity,
    promoterHoldingPct,
    promoterHoldingChangeQoQ,
    dividendYield: parseFloatLoose(get(ratios, 'dividend yield')),
    source: opts.source,
  };
}

function get(map: Map<string, string>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = map.get(k.toLowerCase());
    if (v) return v;
  }
  return undefined;
}

function parseFloatLoose(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const cleaned = s.replace(/[%,₹\s]/g, '');
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Screener prints market cap in rupees-crore (e.g. "Rs. 21,34,567 Cr."). We
 * normalise to plain rupees-crore (the unit our schema uses).
 * Handles negative values: "-₹500 Cr." → -500 and "(₹500 Cr.)" → -500.
 */
function parseRupeeCrore(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const isParenNegative = s.startsWith('(') && s.endsWith(')');
  const cleaned = s.replace(/[()a-zA-Z₹.,\s]/g, '');
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n)) return undefined;
  return isParenNegative ? -n : n;
}

function normalizeLabel(s: string): string {
  return s
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Row first-cell looks like "10 Years:", "3 Years:", "TTM:", "1 Year:" */
function looksLikePeriodCell(s: string): boolean {
  const n = normalizeLabel(s);
  return (
    /\bttm\b/i.test(n) ||
    /\d+\s*years?/i.test(n) ||
    /\d+\s*yrs?/i.test(n) ||
    /\d+\s*year\b/i.test(n)
  );
}

function extractTtmValue(cells: string[]): string | undefined {
  const hasTtm = cells.some((c) => /\bttm\b/i.test(c));
  if (!hasTtm) return undefined;
  return cells[cells.length - 1];
}

function parseGrowthFromRangesTables($: CheerioAPI): { revenue?: number; profit?: number } {
  let revenue: number | undefined;
  let profit: number | undefined;

  $('table.ranges-table').each((_, tableEl) => {
    const rows = $(tableEl).find('tr').toArray();
    if (rows.length === 0) return;

    const sectionKey = normalizeLabel($(rows[0]).text());
    let carryLabel = '';

    for (let i = 0; i < rows.length; i++) {
      const $tr = $(rows[i]);
      const cells = $tr
        .find('td')
        .map((_, td) => normalizeLabel($(td).text()))
        .get();
      if (cells.length === 0) continue;

      if (cells.length >= 3) {
        const c0 = cells[0];
        if (c0 && !looksLikePeriodCell(c0) && !/\bttm\b/i.test(c0)) {
          carryLabel = c0;
        }
        const label = (carryLabel || sectionKey).toLowerCase();
        const valueStr = extractTtmValue(cells);
        if (!valueStr) continue;
        const val = parseFloatLoose(valueStr);
        if (val === undefined) continue;
        if (label.includes('sales')) revenue = val;
        if (label.includes('profit') && label.includes('growth')) profit = val;
        continue;
      }

      if (cells.length >= 2) {
        const period = cells[0] ?? '';
        const valueStr = cells[cells.length - 1] ?? '';
        if (!/\bttm\b/i.test(period)) continue;
        const val = parseFloatLoose(valueStr);
        if (val === undefined) continue;
        if (sectionKey.includes('sales')) revenue = val;
        if (sectionKey.includes('profit') && sectionKey.includes('growth')) profit = val;
      }
    }
  });

  return { revenue, profit };
}

function parsePromoterShareholding($: CheerioAPI): { pct?: number; changeQoQ?: number } {
  const $table = $('#shareholding table').first();
  if ($table.length === 0) return {};

  let $row = $table.find('tbody tr').filter((_, tr) => {
    const t = normalizeLabel($(tr).find('td').first().text());
    return t === 'promoters' || t.startsWith('promoters');
  });
  if ($row.length === 0) {
    $row = $table.find('tbody tr').filter((_, tr) => {
      const t = normalizeLabel($(tr).find('td').first().text());
      return t.includes('promoter');
    });
  }
  if ($row.length === 0) return {};

  const nums: number[] = [];
  $row
    .first()
    .find('td')
    .slice(1)
    .each((_, td) => {
      const n = parseFloatLoose($(td).text());
      if (n !== undefined) nums.push(n);
    });

  if (nums.length === 0) return {};
  const latest = nums.at(-1);
  if (latest === undefined) return {};
  if (nums.length < 2) {
    return { pct: latest };
  }
  const prev = nums.at(-2);
  if (prev === undefined) {
    return { pct: latest };
  }
  return { pct: latest, changeQoQ: Math.round((latest - prev) * 100) / 100 };
}

function isDebtToEquityLabel(label: string): boolean {
  const n = normalizeLabel(label);
  if (!n || n.includes('debtor')) return false;
  if (/(^|\s)(debt\s*\/\s*equity|debt\s+to\s+equity)(\s|$)/.test(n)) return true;
  if (/^d\s*\/\s*e$/i.test(n.trim())) return true;
  return n.includes('debt') && n.includes('equity');
}

function parseDebtToEquityFromDataTables($: CheerioAPI): number | undefined {
  for (const section of ['#balance-sheet', '#ratios']) {
    const $sec = $(section);
    if ($sec.length === 0) continue;
    const $rows = $sec.find('table.data-table tbody tr');
    for (let i = 0; i < $rows.length; i++) {
      const rowEl = $rows[i];
      if (!rowEl) continue;
      const $r = $(rowEl);
      const label = $r.find('td').first().text();
      if (!isDebtToEquityLabel(label)) continue;
      const $cells = $r.find('td');
      if ($cells.length < 2) continue;
      const v = parseFloatLoose($cells.last().text());
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

/**
 * Compute debt-to-equity from balance sheet line items when no direct label
 * exists. Screener.in shows "Borrowings" as total debt (often under a
 * collapsible row with "+" suffix) and "Equity Capital" + "Reserves" as
 * equity components. We skip child rows (indented or collapsible children).
 */
function computeDebtToEquityFromBalanceSheet($: CheerioAPI): number | undefined {
  const $sec = $('#balance-sheet');
  if ($sec.length === 0) return undefined;

  const $rows = $sec.find('table.data-table tbody tr');
  let borrowings: number | undefined;
  let equityCapital: number | undefined;
  let reserves: number | undefined;

  for (let i = 0; i < $rows.length; i++) {
    const $r = $($rows[i]);
    const label = normalizeLabel($r.find('td').first().text());
    if (!label) continue;

    const $cells = $r.find('td');
    if ($cells.length < 2) continue;
    const val = parseRupeeCrore($cells.last().text());
    if (val === undefined) continue;

    // "Borrowings" is the total debt line (often has "+" for expandable sub-rows).
    // Sub-rows appear after the total, so first match is always the aggregate.
    if (
      label === 'borrowings' ||
      label === 'borrowing' ||
      label.startsWith('borrowings') ||
      label.startsWith('borrowing')
    ) {
      // Only capture the top-level row (the sum), not expanded sub-rows
      if (borrowings === undefined) borrowings = val;
    } else if (label === 'equity capital') {
      // "Equity Capital" — first column is always the main number
      equityCapital = val;
    } else if (label === 'reserves') {
      reserves = val;
    }
  }

  if (borrowings === undefined || equityCapital === undefined || reserves === undefined)
    return undefined;

  const totalEquity = equityCapital + reserves;
  if (totalEquity <= 0) return undefined;

  const ratio = borrowings / totalEquity;
  return Number.isFinite(ratio) && ratio >= 0 ? Math.round(ratio * 100) / 100 : undefined;
}

// ---------------------------------------------------------------------------
// Quarterly Fundamentals (from #quarters table)
// ---------------------------------------------------------------------------

const MONTH_MAP: Record<string, string> = {
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

function lastDayOfMonth(month: string, year: number): string {
  return String(new Date(year, +month, 0).getDate());
}

/**
 * Convert a Screener.in period label ("Dec 2025", "Dec 25", "Dec'25", "2025") to YYYY-MM-DD.
 * Quarterly labels → last day of that month.
 * Annual labels → 2025-12-31.
 */
function periodLabelToDate(label: string): string | null {
  const trimmed = label.trim();

  // Try quarterly format: "Dec 2025", "Dec 25", "Dec'25", "Dec' 25", "Dec-25"
  const qMatch = trimmed.match(/^(\w{3})\s*['\u2019]?\s*(\d{2,4})$/i);
  if (qMatch?.[1] && qMatch[2]) {
    const monthNum = MONTH_MAP[qMatch[1]?.toLowerCase()];
    if (!monthNum) return null;
    // biome-ignore lint/style/noNonNullAssertion: guarded by if (qMatch[2]) above
    let year = Number.parseInt(qMatch[2]!, 10);
    if (!Number.isFinite(year)) return null;
    // Normalize 2-digit years to 4-digit: 25 → 2025, 98 → 1998
    if (year < 100) {
      year += year >= 50 ? 1900 : 2000;
    }
    const yearStr = String(year);
    return `${yearStr}-${monthNum}-${lastDayOfMonth(monthNum, year)}`;
  }

  // Try annual format: "2025"
  const yMatch = trimmed.match(/^(\d{4})$/);
  if (yMatch) return `${yMatch[1]}-12-31`;
  return null;
}

/** Labels in the #quarters table that map to revenue. */
function isRevenueLabel(label: string): boolean {
  const n = normalizeLabel(label);
  // Screener.in often appends "+" or optional suffixes ("Sales +"), so use startsWith
  return (
    n.startsWith('sales') ||
    n.startsWith('revenue') ||
    n.startsWith('total revenue') ||
    n.startsWith('total sales') ||
    n.startsWith('income') ||
    n.startsWith('revenue from operations')
  );
}

/** Labels in the #quarters table that map to operating profit. */
function isOperatingProfitLabel(label: string): boolean {
  const n = normalizeLabel(label);
  return n.startsWith('operating profit') || n.startsWith('op profit');
}

/** Labels in the #quarters table that map to OPM %. */
function isOpmLabel(label: string): boolean {
  const n = normalizeLabel(label);
  return n.startsWith('opm') || n.startsWith('operating profit margin');
}

/** Labels in the #quarters table that map to net profit. Excludes Profit Before Tax / PBT / exceptional items. */
function isNetProfitLabel(label: string): boolean {
  const n = normalizeLabel(label);
  // Exclude gross profit, PBT, and other non-net-profit lines
  if (n.startsWith('gross profit')) return false;
  if (/before tax|pretax|pbt|exceptional|extraordinary|discontinued/i.test(n)) return false;
  return n.startsWith('net profit') || n.startsWith('profit') || n.startsWith('net income');
}

/** Labels in the #quarters table that map to EPS. */
function isEpsLabel(label: string): boolean {
  const n = normalizeLabel(label);
  return (
    n.startsWith('eps') ||
    n.startsWith('earnings per share') ||
    n.startsWith('diluted eps') ||
    n.startsWith('basic eps')
  );
}

/** Labels in the #cash-flow table that map to operating cash flow. */
function isOperatingCashFlowLabel(label: string): boolean {
  const n = normalizeLabel(label);
  return (
    n.startsWith('cash from operating') ||
    n.startsWith('cash from ops') ||
    n.startsWith('operating cash flow')
  );
}

/** Labels in the #cash-flow table that map to free cash flow. */
function isFreeCashFlowLabel(label: string): boolean {
  const n = normalizeLabel(label);
  return n.startsWith('free cash flow') || n.startsWith('fcf');
}

interface FinancialTable {
  headers: string[];
  rows: Record<string, string[]>;
}

/**
 * Parse a Screener.in financial table (data-table) inside a section.
 * Returns headers (period labels) and rows keyed by row label.
 */
function parseFinancialTable($: CheerioAPI, sectionId: string): FinancialTable | null {
  const $section = $(`${sectionId} table.data-table`);
  if ($section.length === 0) return null;

  const headers: string[] = [];
  $section.find('thead th').each((_, th) => {
    headers.push($(th).text().trim());
  });

  // Skip header-only tables
  if (headers.length < 2) return null;

  const rows: Record<string, string[]> = {};
  $section.find('tbody tr').each((_, tr) => {
    const cells: string[] = [];
    $(tr)
      .find('td')
      .each((_, td) => {
        cells.push($(td).text().trim());
      });
    if (cells.length >= 2) {
      const label = cells[0];
      if (label) {
        rows[label] = cells.slice(1);
      }
    }
  });

  if (Object.keys(rows).length === 0) return null;

  return { headers, rows };
}

/**
 * Extract quarterly financial data from the #quarters table.
 * Returns an array of QuarterlyFundamentals, one per detected quarter.
 */
export function parseQuarterlyFundamentals(
  html: string,
  opts: ParseScreenerOptions,
): QuarterlyFundamentals[] {
  const $ = load(html);
  const table = parseFinancialTable($, '#quarters');
  if (!table) return [];

  const symbol = opts.symbol.toUpperCase();
  const source = opts.source;
  const result: QuarterlyFundamentals[] = [];

  // Column 0 is the first data column (most recent quarter)
  for (let colIdx = 0; colIdx < table.headers.length - 1; colIdx++) {
    // header[0] is usually empty (row labels column)
    // header[colIdx + 1] is the period label
    const periodHeader = table.headers[colIdx + 1];
    if (!periodHeader) continue;

    const quarterEnd = periodLabelToDate(periodHeader);
    if (!quarterEnd) continue;

    let revenue: number | undefined;
    let operatingProfit: number | undefined;
    let opmPct: number | undefined;
    let netProfit: number | undefined;
    let eps: number | undefined;

    for (const [rowLabel, values] of Object.entries(table.rows)) {
      const val = values[colIdx];
      if (val === undefined || val === '' || val === '-') continue;

      if (isRevenueLabel(rowLabel)) {
        revenue = parseRupeeCrore(val);
      } else if (isOperatingProfitLabel(rowLabel)) {
        operatingProfit = parseRupeeCrore(val);
      } else if (isOpmLabel(rowLabel)) {
        opmPct = parseFloatLoose(val);
      } else if (isNetProfitLabel(rowLabel)) {
        netProfit = parseRupeeCrore(val);
      } else if (isEpsLabel(rowLabel)) {
        eps = parseFloatLoose(val);
      }
    }

    result.push({
      symbol,
      quarterEnd,
      revenue,
      operatingProfit,
      opmPct,
      netProfit,
      eps,
      operatingCashFlow: undefined,
      freeCashFlow: undefined,
      source,
    });
  }

  return result;
}

/**
 * Extract annual cash flow data from the #cash-flow table.
 * Returns QuarterlyFundamentals rows with cash flow fields populated at fiscal year end.
 * Cash flow data on Screener.in is annual (fiscal year columns).
 */
export function parseCashFlowFundamentals(
  html: string,
  opts: ParseScreenerOptions,
): QuarterlyFundamentals[] {
  const $ = load(html);
  const table = parseFinancialTable($, '#cash-flow');
  if (!table) return [];

  const symbol = opts.symbol.toUpperCase();
  const source = opts.source;
  const result: QuarterlyFundamentals[] = [];

  for (let colIdx = 0; colIdx < table.headers.length - 1; colIdx++) {
    const periodHeader = table.headers[colIdx + 1];
    if (!periodHeader) continue;

    const periodEnd = periodLabelToDate(periodHeader);
    if (!periodEnd) continue;

    let operatingCashFlow: number | undefined;
    let freeCashFlow: number | undefined;

    for (const [rowLabel, values] of Object.entries(table.rows)) {
      const val = values[colIdx];
      if (val === undefined || val === '' || val === '-') continue;

      if (isOperatingCashFlowLabel(rowLabel)) {
        operatingCashFlow = parseRupeeCrore(val);
      } else if (isFreeCashFlowLabel(rowLabel)) {
        freeCashFlow = parseRupeeCrore(val);
      }
    }

    result.push({
      symbol,
      quarterEnd: periodEnd,
      operatingCashFlow,
      freeCashFlow,
      source,
    });
  }

  return result;
}
