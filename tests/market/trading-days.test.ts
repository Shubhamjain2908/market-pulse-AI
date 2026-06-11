import { describe, expect, it } from 'vitest';
import { lastOpenOnOrBefore, nextOpenOnOrAfter } from '../../src/market/trading-days.js';

describe('nextOpenOnOrAfter', () => {
  it('Sunday → next Monday', () => {
    expect(nextOpenOnOrAfter('2026-02-01')).toBe('2026-02-02');
  });

  it('Friday → same Friday', () => {
    expect(nextOpenOnOrAfter('2026-04-30')).toBe('2026-04-30');
  });

  it('Saturday → next Monday', () => {
    expect(nextOpenOnOrAfter('2026-05-02')).toBe('2026-05-04');
  });

  it('day before a holiday Monday → Tuesday', () => {
    // Republic Day 2026-01-26 is a Monday holiday.
    expect(nextOpenOnOrAfter('2026-01-25')).toBe('2026-01-27');
  });

  it('is symmetric with lastOpenOnOrBefore on open days', () => {
    const openDay = '2026-04-30';
    expect(nextOpenOnOrAfter(openDay)).toBe(openDay);
    expect(lastOpenOnOrBefore(openDay)).toBe(openDay);
  });
});
