import { describe, expect, it } from 'vitest';
import { pickVixCloseOnOrBefore } from '../../src/enrichers/regime-signals.js';

describe('pickVixCloseOnOrBefore', () => {
  const rows = [
    { date: '2026-06-10', close: 15.63 },
    { date: '2026-06-11', close: 15.61 },
    { date: '2026-06-12', close: 14.72 },
  ];

  it('returns exact session row when present', () => {
    const pick = pickVixCloseOnOrBefore(rows, '2026-06-11');
    expect(pick).toEqual({ row: { date: '2026-06-11', close: 15.61 }, stale: false });
  });

  it('carries forward latest close when session row is missing', () => {
    const pick = pickVixCloseOnOrBefore(rows, '2026-06-15');
    expect(pick).toEqual({ row: { date: '2026-06-12', close: 14.72 }, stale: true });
  });

  it('returns null when no history exists on or before date', () => {
    expect(pickVixCloseOnOrBefore(rows, '2026-06-01')).toBeNull();
  });
});
