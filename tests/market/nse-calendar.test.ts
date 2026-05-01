import { describe, expect, it } from 'vitest';
import {
  getHolidayName,
  getMarketClosure,
  isWeekendIst,
  istWeekdaySun0,
} from '../../src/market/nse-calendar.js';

describe('nse-calendar', () => {
  it('detects weekends in IST', () => {
    expect(isWeekendIst('2026-05-02')).toBe(true); // Saturday
    expect(isWeekendIst('2026-05-03')).toBe(true); // Sunday
    expect(isWeekendIst('2026-05-01')).toBe(false); // Friday (Maharashtra Day holiday but not weekend)
    expect(istWeekdaySun0('2026-05-02')).toBe(6);
  });

  it('returns Maharashtra Day as a trading holiday', () => {
    expect(getHolidayName('2026-05-01')).toBe('Maharashtra Day');
    const c = getMarketClosure('2026-05-01');
    expect(c?.kind).toBe('holiday');
    expect(c?.label).toContain('Maharashtra');
  });

  it('treats plain Thursdays as open market days', () => {
    expect(getMarketClosure('2026-04-30')).toBeNull();
  });
});
