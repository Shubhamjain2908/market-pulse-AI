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
import type { Fundamentals } from '../../types/domain.js';
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

  let debtToEquity: number | undefined;
  try {
    debtToEquity =
      parseFloatLoose(get(ratios, 'debt / equity', 'debt to equity', 'd/e')) ??
      parseDebtToEquityFromDataTables($);
  } catch (err) {
    log.debug({ symbol: opts.symbol, err }, 'screener debt/equity parse failed');
    debtToEquity = parseFloatLoose(get(ratios, 'debt / equity', 'debt to equity', 'd/e'));
  }

  return {
    symbol: opts.symbol.toUpperCase(),
    asOf: opts.asOf ?? isoDateIst(),
    marketCap: parseRupeeCrore(get(ratios, 'market cap')),
    pe: parseFloatLoose(get(ratios, 'stock p/e', 'p/e')),
    pb: parseFloatLoose(get(ratios, 'price to book value', 'p/b')),
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
 */
function parseRupeeCrore(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const cleaned = s.replace(/[a-zA-Z₹.,\s]/g, '');
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : undefined;
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
