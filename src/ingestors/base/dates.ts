/**
 * Date helpers for IST trading-day reasoning. SQLite stores dates as
 * 'YYYY-MM-DD' so we centralise conversions here.
 */

import { MARKET_TIMEZONE } from '../../constants.js';

const ISO_DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

/** Format a Date as 'YYYY-MM-DD' in IST. */
export function isoDateIst(d: Date = new Date()): string {
  // toLocaleDateString with sv-SE produces YYYY-MM-DD format reliably
  return d.toLocaleDateString('sv-SE', { timeZone: MARKET_TIMEZONE });
}

export function isIsoDate(s: string): boolean {
  return ISO_DATE_RX.test(s);
}

/** Parse 'YYYY-MM-DD' (interpreted as midnight IST) into a Date. */
export function parseIsoDate(s: string): Date {
  if (!isIsoDate(s)) throw new Error(`invalid ISO date: ${s}`);
  return new Date(`${s}T00:00:00+05:30`);
}

/** Convenience: today in IST as ISO date string. */
export function todayIst(): string {
  return isoDateIst();
}
