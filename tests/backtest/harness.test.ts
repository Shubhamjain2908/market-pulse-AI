import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/backtest/harness.js';
import { closeDb, getDb, migrate } from '../../src/db/index.js';
import type { ScreenDefinition } from '../../src/types/domain.js';

describe('backtest harness: end-to-end with synthetic data', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-bt-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = dbPath;
  });

  afterEach(() => {
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(`${dbPath}${suffix}`);
      } catch {
        // best effort
      }
    }
  });

  it('replays a window, records trades, persists run summary', () => {
    const db = getDb({ path: dbPath });
    migrate(db);

    // Seed a 6-day price series for AAA.
    const dates = [
      '2026-04-01',
      '2026-04-02',
      '2026-04-03',
      '2026-04-04',
      '2026-04-05',
      '2026-04-06',
    ];
    const closes = [100, 95, 100, 110, 108, 115];
    const insertQuote = db.prepare(`
      INSERT INTO quotes (symbol, exchange, date, open, high, low, close, adj_close, volume, source)
      VALUES (?, 'NSE', ?, ?, ?, ?, ?, ?, 0, 'test')
    `);
    for (let i = 0; i < dates.length; i++) {
      const d = dates[i] as string;
      const c = closes[i] as number;
      insertQuote.run('AAA', d, c, c, c, c, c);
    }

    // RSI fires on days 1 and 3 (oversold).
    const rsi: Record<string, number> = {
      '2026-04-01': 30,
      '2026-04-02': 50,
      '2026-04-03': 32,
      '2026-04-04': 60,
      '2026-04-05': 55,
      '2026-04-06': 45,
    };
    const insertSignal = db.prepare(`
      INSERT INTO signals (symbol, date, name, value, source)
      VALUES (?, ?, 'rsi_14', ?, 'technical')
    `);
    for (const [d, v] of Object.entries(rsi)) insertSignal.run('AAA', d, v);

    const screens: ScreenDefinition[] = [
      {
        name: 'rsi_dip',
        label: 'RSI Dip',
        description: 'oversold buy',
        timeHorizon: 'short',
        criteria: [{ signal: 'rsi_14', op: 'lt', value: 35 }],
      },
    ];

    const summary = runBacktest(
      {
        startDate: '2026-04-01',
        endDate: '2026-04-06',
        holdDays: 2,
        symbols: ['AAA'],
        screens,
      },
      db,
    );

    expect(summary.totalRuns).toBe(1);
    const run = summary.results[0];
    if (!run) throw new Error('expected run');
    expect(run.screenName).toBe('rsi_dip');
    expect(run.metrics.totalTrades).toBe(2);

    // Trade 1: signal on 04-01, entry on 04-02 (close=95), exit on 04-04 (close=110)
    // Trade 2: signal on 04-03, entry on 04-04 (close=110), exit on 04-06 (close=115)
    const trades = run.trades.map((t) => ({ entry: t.entryDate, exit: t.exitDate }));
    expect(trades).toEqual([
      { entry: '2026-04-02', exit: '2026-04-04' },
      { entry: '2026-04-04', exit: '2026-04-06' },
    ]);

    expect(run.metrics.winningTrades).toBe(2);
    expect(run.metrics.hitRate).toBe(1);
    expect(run.metrics.avgReturnPct).toBeGreaterThan(0);

    const runRow = db
      .prepare('SELECT total_trades AS total, hit_rate AS hitRate FROM backtest_runs WHERE id = ?')
      .get(run.runId) as { total: number; hitRate: number };
    expect(runRow.total).toBe(2);
    expect(runRow.hitRate).toBe(1);
    const tradeRows = db
      .prepare('SELECT COUNT(*) AS n FROM backtest_trades WHERE run_id = ?')
      .get(run.runId) as { n: number };
    expect(tradeRows.n).toBe(2);
  });

  it('produces zero trades when no screen matches in the window', () => {
    const db = getDb({ path: dbPath });
    migrate(db);

    db.prepare(`
      INSERT INTO quotes (symbol, exchange, date, open, high, low, close, adj_close, volume, source)
      VALUES ('AAA','NSE','2026-04-01',100,100,100,100,0,0,'test'),
             ('AAA','NSE','2026-04-02',101,101,101,101,0,0,'test')
    `).run();

    const screens: ScreenDefinition[] = [
      {
        name: 'never_fires',
        label: 'Never',
        description: 'requires missing signal',
        timeHorizon: 'short',
        criteria: [{ signal: 'rsi_14', op: 'lt', value: 0 }],
      },
    ];

    const summary = runBacktest(
      { startDate: '2026-04-01', endDate: '2026-04-02', symbols: ['AAA'], screens },
      db,
    );
    expect(summary.results[0]?.metrics.totalTrades).toBe(0);
  });
});
