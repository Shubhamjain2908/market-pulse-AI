import { describe, expect, it } from 'vitest';
import { pickFirstFutureEarningsDateIso } from '../../src/ingestors/yahoo/earnings-ingestor.js';

describe('pickFirstFutureEarningsDateIso', () => {
  it('returns null for non-array or empty', () => {
    expect(pickFirstFutureEarningsDateIso(null, '2026-05-07')).toBe(null);
    expect(pickFirstFutureEarningsDateIso(undefined, '2026-05-07')).toBe(null);
    expect(pickFirstFutureEarningsDateIso([], '2026-05-07')).toBe(null);
  });

  it('skips dates strictly before refIso and picks earliest on or after ref', () => {
    const arr = [
      '2026-04-01T10:00:00.000Z',
      '2026-06-15T10:00:00.000Z',
      '2026-07-01T10:00:00.000Z',
    ];
    const picked = pickFirstFutureEarningsDateIso(arr, '2026-05-07');
    expect(picked).toBeDefined();
    if (picked) {
      expect(picked.localeCompare('2026-05-07')).toBeGreaterThanOrEqual(0);
      expect(picked.startsWith('2026-06')).toBe(true);
    }
  });

  it('returns null when all dates are in the past vs ref', () => {
    const arr = ['2026-01-01T10:00:00.000Z', '2026-02-01T10:00:00.000Z'];
    expect(pickFirstFutureEarningsDateIso(arr, '2026-05-07')).toBe(null);
  });
});
