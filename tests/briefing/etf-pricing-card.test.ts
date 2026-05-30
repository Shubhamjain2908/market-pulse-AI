import { describe, expect, it } from 'vitest';
import {
  alertsFromSnapshots,
  classifyEtfPricingAlert,
} from '../../src/briefing/etf-pricing-card.js';
import type { InavSnapshotRow } from '../../src/db/queries.js';

describe('classifyEtfPricingAlert', () => {
  it('WARN above 0.5% premium', () => {
    expect(classifyEtfPricingAlert(0.6)).toBe('warn');
  });

  it('NOTE below -0.25% discount', () => {
    expect(classifyEtfPricingAlert(-0.3)).toBe('note');
  });

  it('suppresses between-band noise', () => {
    expect(classifyEtfPricingAlert(0.3)).toBeNull();
    expect(classifyEtfPricingAlert(-0.1)).toBeNull();
  });
});

describe('alertsFromSnapshots', () => {
  const base: InavSnapshotRow = {
    symbol: 'NIFTYBEES',
    date: '2026-05-30',
    inav: 100,
    lastPrice: 100,
    premiumDiscountPct: 0,
    capturedAt: '2026-05-30T00:00:00.000Z',
  };

  it('includes only WARN and NOTE rows', () => {
    const snaps: InavSnapshotRow[] = [
      { ...base, symbol: 'NIFTYBEES', premiumDiscountPct: 0.6 },
      { ...base, symbol: 'GOLDBEES', premiumDiscountPct: 0.35 },
      { ...base, symbol: 'SILVERBEES', premiumDiscountPct: -0.4 },
    ];
    const alerts = alertsFromSnapshots(['NIFTYBEES', 'GOLDBEES', 'SILVERBEES'], snaps);
    expect(alerts.map((a) => a.symbol).sort()).toEqual(['NIFTYBEES', 'SILVERBEES']);
  });
});
