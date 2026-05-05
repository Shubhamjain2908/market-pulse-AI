/**
 * Walk IST calendar days for NSE cash sessions (skip weekends + holidays from `nse-calendar`).
 */

import { isIsoDate, isoDateIst, parseIsoDate } from '../ingestors/base/dates.js';
import { getMarketClosure } from './nse-calendar.js';

export function addCalendarDaysIst(isoDate: string, deltaDays: number): string {
  const d = parseIsoDate(isoDate);
  d.setDate(d.getDate() + deltaDays);
  const out = isoDateIst(d);
  if (!isIsoDate(out)) {
    throw new Error(
      `addCalendarDaysIst: invalid calendar result ${JSON.stringify(out)} (${isoDate} ${deltaDays >= 0 ? '+' : ''}${deltaDays})`,
    );
  }
  return out;
}

/**
 * Previous **open** NSE session strictly before `isoDate` (walks IST calendar backward).
 */
export function previousOpenTradingDay(isoDate: string): string | null {
  let cur = addCalendarDaysIst(isoDate, -1);
  for (let i = 0; i < 400; i++) {
    if (!getMarketClosure(cur)) return cur;
    cur = addCalendarDaysIst(cur, -1);
  }
  return null;
}

/** Last open session on or before `isoDate` (same day if already open). */
export function lastOpenOnOrBefore(isoDate: string): string | null {
  let cur = isoDate;
  for (let i = 0; i < 400; i++) {
    if (!getMarketClosure(cur)) return cur;
    cur = addCalendarDaysIst(cur, -1);
  }
  return null;
}

/**
 * Open trading days ending at `endDate` inclusive (snapped to last open on/before endDate),
 * going backward `count` sessions (newest first).
 */
export function listTradingDaysBackward(endDate: string, count: number): string[] {
  const out: string[] = [];
  let cur = lastOpenOnOrBefore(endDate);
  while (out.length < count && cur) {
    out.push(cur);
    cur = previousOpenTradingDay(cur);
  }
  return out;
}
