import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignalProvider } from '../../src/analysers/signal-provider.js';
import { migrate } from '../../src/db/migrate.js';
import { upsertPromoterPledgeRows } from '../../src/db/queries.js';

function insertQualityBaseRows(db: DatabaseType, symbol: string, asOf = '2026-05-28'): void {
  db.prepare(
    `
    INSERT INTO fundamentals (symbol, as_of, roe, roce, revenue_growth_yoy, source)
    VALUES (?, '2025-03-31', 0.21, 0.24, 0.16, 'yahoo_annual'),
           (?, '2024-03-31', 0.19, 0.22, 0.14, 'yahoo_annual'),
           (?, '2023-03-31', 0.2, 0.21, 0.12, 'yahoo_annual')
  `,
  ).run(symbol, symbol, symbol);

  db.prepare(
    `
    INSERT INTO fundamentals (
      symbol, as_of, pe, pb, peg, debt_to_equity, market_cap, source
    ) VALUES (?, ?, 22.4, 3.1, 0.95, 0.12, 1823000000000, 'yahoo_snapshot')
  `,
  ).run(symbol, asOf);

  db.prepare(
    `
    INSERT INTO fundamentals (
      symbol, as_of, promoter_holding_pct, promoter_holding_change_qoq, source
    ) VALUES (?, ?, 67.3, 0.1, 'nse_shareholding')
  `,
  ).run(symbol, '2026-05-27');

  db.prepare(
    `
    INSERT INTO signals (symbol, date, name, value, source)
    VALUES
      (?, ?, 'rsi_14', 41.2, 'technical'),
      (?, ?, 'sma_50', 1420.0, 'technical'),
      (?, ?, 'close', 1438.0, 'technical')
  `,
  ).run(symbol, asOf, symbol, asOf, symbol, asOf);
}

function mockProvider(): SignalProvider {
  return {
    get: (symbol, date, name) => {
      const row = db
        .prepare(`SELECT value FROM signals WHERE symbol = ? AND date = ? AND name = ?`)
        .get(symbol, date, name) as { value: number } | undefined;
      return row?.value ?? null;
    },
  };
}

let db: DatabaseType;
const prevGate = process.env.QUALITY_GARP_PLEDGE_GATE;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  db.prepare(
    `INSERT INTO symbols (symbol, exchange, sector, is_index, is_active) VALUES (?, 'NSE', ?, 0, 1)`,
  ).run('PLEDGE', 'Industrials');
  insertQualityBaseRows(db, 'PLEDGE');
});

afterEach(() => {
  if (prevGate === undefined) delete process.env.QUALITY_GARP_PLEDGE_GATE;
  else process.env.QUALITY_GARP_PLEDGE_GATE = prevGate;
  vi.resetModules();
});

async function runPledgeScreen(gate: '0' | '1') {
  process.env.QUALITY_GARP_PLEDGE_GATE = gate;
  vi.resetModules();
  const { runQualityGarpScreen } = await import('../../src/analysers/quality-garp-screen.js');
  return runQualityGarpScreen(
    {
      date: '2026-05-28',
      symbols: ['PLEDGE'],
      provider: mockProvider(),
      persist: false,
      etfExclusions: new Set(),
    },
    db,
  );
}

describe('quality_garp pledge gate', () => {
  it('shadow mode passes high pledge but increments pledge_shadow', async () => {
    upsertPromoterPledgeRows(
      [
        {
          symbol: 'PLEDGE',
          shpDate: '2026-05-01',
          pctSharesPledged: 30,
          pctPromoterHolding: 60,
          numSharesPledged: 1000,
        },
      ],
      db,
    );

    const result = await runPledgeScreen('0');
    expect(result.matches).toBe(1);
    expect(result.funnel.passed).toBe(1);
    expect(result.funnel.pledge).toBe(0);
    expect(result.funnel.pledge_shadow).toBe(1);
  });

  it('live gate blocks when pledge exceeds 15%', async () => {
    upsertPromoterPledgeRows(
      [
        {
          symbol: 'PLEDGE',
          shpDate: '2026-05-01',
          pctSharesPledged: 30,
          pctPromoterHolding: 60,
          numSharesPledged: 1000,
        },
      ],
      db,
    );

    const result = await runPledgeScreen('1');
    expect(result.matches).toBe(0);
    expect(result.funnel.pledge).toBe(1);
    expect(result.funnel.passed).toBe(0);
  });

  it('fail-open when no pledge row and increments pledge_skipped', async () => {
    const result = await runPledgeScreen('0');
    expect(result.matches).toBe(1);
    expect(result.funnel.pledge_skipped).toBe(1);
    expect(result.funnel.pledge_shadow).toBe(0);
  });
});
