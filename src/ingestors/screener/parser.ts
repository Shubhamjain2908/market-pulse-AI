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

import { load } from 'cheerio';
import type { Fundamentals } from '../../types/domain.js';
import { isoDateIst } from '../base/dates.js';

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

  if (ratios.size === 0) return null;

  return {
    symbol: opts.symbol.toUpperCase(),
    asOf: opts.asOf ?? isoDateIst(),
    marketCap: parseRupeeCrore(get(ratios, 'market cap')),
    pe: parseFloatLoose(get(ratios, 'stock p/e', 'p/e')),
    pb: parseFloatLoose(get(ratios, 'price to book value', 'p/b')),
    roe: parseFloatLoose(get(ratios, 'roe', 'return on equity')),
    roce: parseFloatLoose(get(ratios, 'roce', 'return on capital employed')),
    debtToEquity: parseFloatLoose(get(ratios, 'debt to equity', 'd/e')),
    promoterHoldingPct: parseFloatLoose(get(ratios, 'promoter holding')),
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
