import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { getQualityDecayScore } from '../../src/db/queries.js';

function seedQuarterlyData(
  db: DatabaseType,
  symbol: string,
  quarters: Array<{
    quarterEnd: string;
    netProfit: number | null;
    operatingCashFlow: number | null;
    opmPct: number | null;
    revenue: number | null;
  }>,
): void {
  const stmt = db.prepare(`
    INSERT INTO quarterly_fundamentals (
      symbol, quarter_end, net_profit, operating_cash_flow, opm_pct, revenue, source
    ) VALUES (?, ?, ?, ?, ?, ?, 'screener')
  `);
  for (const q of quarters) {
    stmt.run(symbol, q.quarterEnd, q.netProfit, q.operatingCashFlow, q.opmPct, q.revenue);
  }
}

describe('getQualityDecayScore', () => {
  it('returns null when fewer than 5 quarters', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedQuarterlyData(db, 'TEST', [
      {
        quarterEnd: '2025-03-31',
        netProfit: 100,
        operatingCashFlow: 120,
        opmPct: 18,
        revenue: 1000,
      },
      { quarterEnd: '2024-12-31', netProfit: 90, operatingCashFlow: 110, opmPct: 17, revenue: 900 },
      { quarterEnd: '2024-09-30', netProfit: 80, operatingCashFlow: 100, opmPct: 16, revenue: 800 },
    ]);

    const result = getQualityDecayScore('TEST', '2025-06-30', db);
    expect(result).toBeNull();
  });

  it('scores 6 when all signals are healthy', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedQuarterlyData(db, 'HEALTHY', [
      {
        quarterEnd: '2025-03-31',
        netProfit: 100,
        operatingCashFlow: 120,
        opmPct: 18,
        revenue: 1000,
      },
      { quarterEnd: '2024-12-31', netProfit: 95, operatingCashFlow: 110, opmPct: 17, revenue: 950 },
      { quarterEnd: '2024-09-30', netProfit: 90, operatingCashFlow: 100, opmPct: 16, revenue: 900 },
      { quarterEnd: '2024-06-30', netProfit: 85, operatingCashFlow: 90, opmPct: 15, revenue: 850 },
      { quarterEnd: '2024-03-31', netProfit: 80, operatingCashFlow: 85, opmPct: 14, revenue: 800 },
    ]);

    const result = getQualityDecayScore('HEALTHY', '2025-06-30', db);
    expect(result).not.toBeNull();
    expect(result?.score).toBe(6);
    expect(result?.signals).toEqual({
      netProfitPositive: true,
      netProfitImproving: true,
      ocfPositive: true,
      ocfExceedsNetProfit: true,
      opmImproving: true,
      revenueImproving: true,
    });
    expect(result?.quartersAvailable).toBe(5);
  });

  it('scores 0 when all signals are negative', () => {
    const db = new Database(':memory:');
    migrate(db);
    // OCF = -120 < netProfit = -100, so ocfExceedsNetProfit is false
    seedQuarterlyData(db, 'DYING', [
      {
        quarterEnd: '2025-03-31',
        netProfit: -100,
        operatingCashFlow: -120,
        opmPct: 10,
        revenue: 500,
      },
      {
        quarterEnd: '2024-12-31',
        netProfit: -80,
        operatingCashFlow: -100,
        opmPct: 12,
        revenue: 600,
      },
      {
        quarterEnd: '2024-09-30',
        netProfit: -60,
        operatingCashFlow: -80,
        opmPct: 14,
        revenue: 700,
      },
      {
        quarterEnd: '2024-06-30',
        netProfit: -40,
        operatingCashFlow: -60,
        opmPct: 16,
        revenue: 800,
      },
      {
        quarterEnd: '2024-03-31',
        netProfit: -20,
        operatingCashFlow: -40,
        opmPct: 18,
        revenue: 900,
      },
    ]);

    const result = getQualityDecayScore('DYING', '2025-06-30', db);
    expect(result).not.toBeNull();
    expect(result?.score).toBe(0);
    expect(result?.signals).toEqual({
      netProfitPositive: false,
      netProfitImproving: false,
      ocfPositive: false,
      ocfExceedsNetProfit: false,
      opmImproving: false,
      revenueImproving: false,
    });
  });

  it('OCF < net_profit reduces score by 1 (accruals check)', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedQuarterlyData(db, 'ACCRUAL', [
      {
        quarterEnd: '2025-03-31',
        netProfit: 100,
        operatingCashFlow: 80,
        opmPct: 18,
        revenue: 1000,
      },
      { quarterEnd: '2024-12-31', netProfit: 95, operatingCashFlow: 90, opmPct: 17, revenue: 950 },
      { quarterEnd: '2024-09-30', netProfit: 90, operatingCashFlow: 100, opmPct: 16, revenue: 900 },
      { quarterEnd: '2024-06-30', netProfit: 85, operatingCashFlow: 90, opmPct: 15, revenue: 850 },
      { quarterEnd: '2024-03-31', netProfit: 80, operatingCashFlow: 85, opmPct: 14, revenue: 800 },
    ]);

    // All signals healthy EXCEPT ocfExceedsNetProfit (OCF 80 < net_profit 100)
    const result = getQualityDecayScore('ACCRUAL', '2025-06-30', db);
    expect(result).not.toBeNull();
    expect(result?.score).toBe(5);
    expect(result?.signals.ocfExceedsNetProfit).toBe(false);
  });

  it('uses symbol as-is (uppercases internally)', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedQuarterlyData(db, 'UPPER', [
      {
        quarterEnd: '2025-03-31',
        netProfit: 100,
        operatingCashFlow: 120,
        opmPct: 18,
        revenue: 1000,
      },
      { quarterEnd: '2024-12-31', netProfit: 95, operatingCashFlow: 110, opmPct: 17, revenue: 950 },
      { quarterEnd: '2024-09-30', netProfit: 90, operatingCashFlow: 100, opmPct: 16, revenue: 900 },
      { quarterEnd: '2024-06-30', netProfit: 85, operatingCashFlow: 90, opmPct: 15, revenue: 850 },
      { quarterEnd: '2024-03-31', netProfit: 80, operatingCashFlow: 85, opmPct: 14, revenue: 800 },
    ]);

    // Lowercase input should still find the symbol
    const result = getQualityDecayScore('upper', '2025-06-30', db);
    expect(result).not.toBeNull();
    expect(result?.score).toBe(6);
  });

  it('returns null when symbol has zero data', () => {
    const db = new Database(':memory:');
    migrate(db);

    const result = getQualityDecayScore('NODATA', '2025-06-30', db);
    expect(result).toBeNull();
  });

  it('handles null values gracefully — treats as failing', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedQuarterlyData(db, 'NULLS', [
      {
        quarterEnd: '2025-03-31',
        netProfit: null,
        operatingCashFlow: null,
        opmPct: null,
        revenue: 1000,
      },
      { quarterEnd: '2024-12-31', netProfit: 95, operatingCashFlow: 110, opmPct: 17, revenue: 950 },
      { quarterEnd: '2024-09-30', netProfit: 90, operatingCashFlow: 100, opmPct: 16, revenue: 900 },
      { quarterEnd: '2024-06-30', netProfit: 85, operatingCashFlow: 90, opmPct: 15, revenue: 850 },
      { quarterEnd: '2024-03-31', netProfit: 80, operatingCashFlow: 85, opmPct: 14, revenue: 800 },
    ]);

    const result = getQualityDecayScore('NULLS', '2025-06-30', db);
    expect(result).not.toBeNull();
    expect(result?.score).toBe(1); // Only revenueImproving is true
    expect(result?.signals.netProfitPositive).toBe(false);
    expect(result?.signals.ocfPositive).toBe(false);
    expect(result?.signals.opmImproving).toBe(false);
  });
});
