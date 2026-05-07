import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, migrate, upsertSignals } from '../../src/db/index.js';
import {
  betaFromAlignedReturns,
  computeMom121ReturnPct,
  computeRelativeStrengthBetaAdjusted,
  computeVolumeBreakoutFlag,
  enrichMomentumSignals,
  pickCloseAtLagWithFallback,
} from '../../src/enrichers/momentum-signals.js';
import { isoDateIst, parseIsoDate } from '../../src/ingestors/base/dates.js';
import { NIFTY_BENCHMARK_SYMBOL } from '../../src/market/benchmarks.js';

function addDaysIso(start: string, delta: number): string {
  const d = parseIsoDate(start);
  d.setDate(d.getDate() + delta);
  return isoDateIst(d);
}

describe('momentum-signals pure helpers', () => {
  it('pickCloseAtLagWithFallback finds ±slack', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(pickCloseAtLagWithFallback(closes, 21, 5)).toBe(closes[closes.length - 21]);
    expect(pickCloseAtLagWithFallback(closes, 253, 5)).toBe(null);
  });

  it('computeMom121ReturnPct matches hand-checked example', () => {
    const closes = Array.from({ length: 260 }, (_, i) => 100 + i * 0.5);
    const pct = computeMom121ReturnPct(closes, 21, 253, 5);
    expect(pct).not.toBeNull();
    const shortPx = closes[closes.length - 21];
    const longPx = closes[closes.length - 253];
    if (shortPx === undefined || longPx === undefined || longPx === 0) {
      throw new Error('fixture');
    }
    expect(pct).toBeCloseTo(((shortPx - longPx) / longPx) * 100, 6);
  });

  it('computeVolumeBreakoutFlag respects price + volume gates', () => {
    const closes = Array.from({ length: 252 }, () => 100);
    closes[251] = 97;
    expect(computeVolumeBreakoutFlag(closes, 2, 252, 0.97, 1.5)).toBe(1);
    expect(computeVolumeBreakoutFlag(closes, 1.4, 252, 0.97, 1.5)).toBe(0);
  });

  it('betaFromAlignedReturns recovers slope when spread is non-degenerate', () => {
    const xs = Array.from({ length: 252 }, (_, i) => (i % 7) * 0.0001);
    const ys = xs.map((x) => 1.5 * x);
    const beta = betaFromAlignedReturns(ys, xs);
    expect(beta).toBeCloseTo(1.5, 2);
  });

  it('computeRelativeStrengthBetaAdjusted nears zero when stock tracks bench', () => {
    const n = 260;
    let s = 100;
    let b = 200;
    const stock: number[] = [];
    const bench: number[] = [];
    for (let i = 0; i < n; i++) {
      stock.push(s);
      bench.push(b);
      s *= 1.002;
      b *= 1.002;
    }
    const rs = computeRelativeStrengthBetaAdjusted(stock, bench, 63, 252, 0.5);
    expect(rs).not.toBeNull();
    if (rs != null) {
      expect(Math.abs(rs)).toBeLessThan(0.02);
    }
  });

  it('computeRelativeStrengthBetaAdjusted falls back to raw spread without full beta window', () => {
    const n = 80;
    let s = 100;
    let b = 200;
    const stock: number[] = [];
    const bench: number[] = [];
    for (let i = 0; i < n; i++) {
      stock.push(s);
      bench.push(b);
      s *= 1.002;
      b *= 1.002;
    }
    const rs = computeRelativeStrengthBetaAdjusted(stock, bench, 63, 252, 0.5);
    expect(rs).not.toBeNull();
    if (rs != null) {
      expect(Math.abs(rs)).toBeLessThan(0.02);
    }
  });
});

describe('enrichMomentumSignals integration', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-momsig-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = dbPath;
  });

  afterEach(() => {
    closeDb();
    try {
      rmSync(dbPath);
      rmSync(`${dbPath}-wal`);
      rmSync(`${dbPath}-shm`);
    } catch {
      // ignore
    }
  });

  it('writes momentum factor rows when history is sufficient', () => {
    const db = getDb({ path: dbPath });
    migrate(db);

    const start = '2025-03-01';
    const n = 300;
    let s = 100;
    let b = 200;
    for (let i = 0; i < n; i++) {
      const d = addDaysIso(start, i);
      const ins = db.prepare(
        `INSERT INTO quotes (symbol, exchange, date, open, high, low, close, volume, source)
         VALUES (?, 'NSE', ?, ?, ?, ?, ?, ?, 'test')`,
      );
      ins.run('INTTEST', d, s, s, s, s, 1_000_000);
      ins.run(NIFTY_BENCHMARK_SYMBOL, d, b, b, b, b, 5_000_000);
      s *= 1.001;
      b *= 1.001;
    }

    const asOf = addDaysIso(start, n - 1);
    upsertSignals(
      [
        {
          symbol: 'INTTEST',
          date: asOf,
          name: 'volume_ratio_20d',
          value: 2,
          source: 'technical',
        },
      ],
      db,
    );

    const stats = enrichMomentumSignals(asOf, ['INTTEST'], db);
    expect(stats.factorSignalRowsWritten).toBeGreaterThanOrEqual(3);
    expect(stats.blackoutRowsWritten).toBe(1);

    const rows = db
      .prepare(
        `SELECT name, value FROM signals WHERE symbol = 'INTTEST' AND date = ? ORDER BY name`,
      )
      .all(asOf) as Array<{ name: string; value: number }>;
    const names = new Set(rows.map((r) => r.name));
    expect(names.has('mom_12_1_return')).toBe(true);
    expect(names.has('mom_relative_strength_ba')).toBe(true);
    expect(names.has('mom_volume_breakout_flag')).toBe(true);
    expect(names.has('mom_earnings_blackout')).toBe(true);

    db.close();
  });

  it('uses latest quotes before asOf when history exceeds LOOKBACK_CAP (regression)', () => {
    const db = getDb({ path: dbPath });
    migrate(db);

    const start = '2024-06-01';
    const total = 450;
    const ins = db.prepare(
      `INSERT INTO quotes (symbol, exchange, date, open, high, low, close, volume, source)
       VALUES (?, 'NSE', ?, ?, ?, ?, ?, ?, 'test')`,
    );
    for (let i = 0; i < total; i++) {
      const d = addDaysIso(start, i);
      const flat = i < 429;
      const c = flat ? 100 : 1000;
      ins.run('SPIKE', d, c, c, c, c, 1);
      ins.run(NIFTY_BENCHMARK_SYMBOL, d, c, c, c, c, 1);
    }

    const asOf = addDaysIso(start, total - 1);
    upsertSignals(
      [
        {
          symbol: 'SPIKE',
          date: asOf,
          name: 'volume_ratio_20d',
          value: 2,
          source: 'technical',
        },
      ],
      db,
    );

    enrichMomentumSignals(asOf, ['SPIKE'], db);

    const row = db
      .prepare(
        `SELECT value FROM signals WHERE symbol = 'SPIKE' AND date = ? AND name = 'mom_12_1_return'`,
      )
      .get(asOf) as { value: number } | undefined;

    expect(row).toBeDefined();
    if (row) {
      expect(row.value).toBeGreaterThan(50);
    }

    db.close();
  });
});
