/**
 * NSE equity session calendar (weekends + exchange holidays).
 * Holidays are maintained locally — extend `NSE_HOLIDAY_NAMES` when NSE publishes updates.
 */

import { MARKET_TIMEZONE } from '../constants.js';

/** Official / widely published NSE trading holidays (YYYY-MM-DD → label). */
export const NSE_HOLIDAY_NAMES: Readonly<Record<string, string>> = {
  // 2025 (subset — extend as needed)
  '2025-01-26': 'Republic Day',
  '2025-03-14': 'Holi',
  '2025-04-18': 'Good Friday',
  '2025-05-01': 'Maharashtra Day',
  '2025-08-15': 'Independence Day',
  '2025-10-02': 'Mahatma Gandhi Jayanti',
  '2025-10-21': 'Diwali (Balipratipada)',
  '2025-12-25': 'Christmas',

  // 2026 — NSE holiday calendar (15 sessions)
  '2026-01-26': 'Republic Day',
  '2026-03-03': 'Holi',
  '2026-03-26': 'Ram Navami',
  '2026-03-31': 'Mahavir Jayanti',
  '2026-04-03': 'Good Friday',
  '2026-04-14': 'Dr Ambedkar Jayanti',
  '2026-05-01': 'Maharashtra Day',
  '2026-05-28': 'Bakri Id',
  '2026-06-26': 'Muharram',
  '2026-09-14': 'Ganesh Chaturthi',
  '2026-10-02': 'Mahatma Gandhi Jayanti',
  '2026-10-20': 'Dussehra',
  '2026-11-10': 'Diwali (Balipratipada)',
  '2026-11-24': 'Gurunanak Jayanti',
  '2026-12-25': 'Christmas',

  // 2027 — placeholder common holidays (verify when NSE publishes)
  '2027-01-26': 'Republic Day',
  '2027-03-26': 'Holi',
  '2027-04-14': 'Good Friday',
  '2027-05-01': 'Maharashtra Day',
  '2027-08-15': 'Independence Day',
  '2027-10-02': 'Mahatma Gandhi Jayanti',
  '2027-12-25': 'Christmas',
};

export interface MarketClosure {
  kind: 'weekend' | 'holiday';
  /** Human-readable reason (holiday name or "Saturday / Sunday"). */
  label: string;
}

/** IST weekday: 0 = Sunday … 6 = Saturday. */
export function istWeekdaySun0(isoDate: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MARKET_TIMEZONE,
    weekday: 'short',
  }).formatToParts(new Date(`${isoDate}T12:00:00+05:30`));
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const key = wd.length >= 3 ? wd.slice(0, 3) : wd;
  return map[key] ?? 0;
}

export function isWeekendIst(isoDate: string): boolean {
  const d = istWeekdaySun0(isoDate);
  return d === 0 || d === 6;
}

export function getHolidayName(isoDate: string): string | undefined {
  return NSE_HOLIDAY_NAMES[isoDate];
}

/**
 * When the cash equity market is closed for the given calendar day (IST).
 */
export function getMarketClosure(isoDate: string): MarketClosure | null {
  if (isWeekendIst(isoDate)) {
    const d = istWeekdaySun0(isoDate);
    const label = d === 6 ? 'Saturday' : 'Sunday';
    return { kind: 'weekend', label };
  }
  const name = getHolidayName(isoDate);
  if (name) return { kind: 'holiday', label: name };
  return null;
}
