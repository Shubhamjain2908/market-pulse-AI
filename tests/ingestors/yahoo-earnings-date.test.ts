import { describe, expect, it } from 'vitest';
import {
  mergeQuoteSummaryEarningsDates,
  pickFirstFutureEarningsDateIso,
} from '../../src/ingestors/yahoo/earnings-ingestor.js';

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

  it('accepts Date instances returned by yahoo-finance2', () => {
    const arr = [new Date('2026-07-18T10:00:00.000Z'), new Date('2026-08-01T10:00:00.000Z')];
    expect(pickFirstFutureEarningsDateIso(arr, '2026-04-01')).toBe('2026-07-18');
  });

  it('supports mixed Date and string inputs', () => {
    const arr = [new Date('2026-08-01T10:00:00.000Z'), '2026-07-18T10:00:00.000Z'];
    expect(pickFirstFutureEarningsDateIso(arr, '2026-04-01')).toBe('2026-07-18');
  });
});

describe('mergeQuoteSummaryEarningsDates', () => {
  it('concatenates earningsChart and calendarEvents arrays', () => {
    const merged = mergeQuoteSummaryEarningsDates({
      earnings: { earningsChart: { earningsDate: ['2026-06-01T00:00:00.000Z'] } },
      calendarEvents: { earnings: { earningsDate: ['2026-08-01T00:00:00.000Z'] } },
    });
    expect(merged).toHaveLength(2);
  });

  it('uses calendarEvents when earningsChart is absent', () => {
    const merged = mergeQuoteSummaryEarningsDates({
      calendarEvents: { earnings: { earningsDate: ['2026-07-01T00:00:00.000Z'] } },
    });
    expect(pickFirstFutureEarningsDateIso(merged, '2026-05-07')).toMatch(/^2026-07/);
  });
});
