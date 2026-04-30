import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runScreenEngine } from '../../src/analysers/engine.js';
import { closeDb, getDb, migrate } from '../../src/db/index.js';
import type { ScreenDefinition, Signal } from '../../src/types/domain.js';

describe('screen engine: end-to-end against SQLite', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-engine-${Date.now()}-${Math.random()}.db`);
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

  it('matches symbols whose signals satisfy all criteria, partial otherwise', () => {
    const db = getDb({ path: dbPath });
    migrate(db);

    const date = '2026-04-30';
    const insertSignals = (symbol: string, vals: Record<string, number>) => {
      const stmt = db.prepare(`
        INSERT INTO signals (symbol, date, name, value, source)
        VALUES (?, ?, ?, ?, 'technical')
      `);
      for (const [name, value] of Object.entries(vals)) stmt.run(symbol, date, name, value);
    };

    // AAA — passes momentum_breakout (strong setup)
    insertSignals('AAA', {
      pct_from_52w_high: -1,
      volume_ratio_20d: 2.0,
      rsi_14: 65,
      close: 110,
      sma_50: 100,
    });
    // BBB — partial: misses RSI band
    insertSignals('BBB', {
      pct_from_52w_high: -1,
      volume_ratio_20d: 2.0,
      rsi_14: 40,
      close: 110,
      sma_50: 100,
    });
    // CCC — total miss
    insertSignals('CCC', {
      pct_from_52w_high: -20,
      volume_ratio_20d: 0.5,
      rsi_14: 25,
      close: 80,
      sma_50: 100,
    });

    const screens: ScreenDefinition[] = [
      {
        name: 'momentum_breakout',
        label: 'Momentum Breakout',
        description: 'test',
        timeHorizon: 'short',
        criteria: [
          { signal: 'pct_from_52w_high', op: 'gte', value: -3 },
          { signal: 'volume_ratio_20d', op: 'gte', value: 1.5 },
          { signal: 'rsi_14', op: 'between', value: [55, 75] },
          { signal: 'close', op: 'gt_signal', value: 'sma_50' },
        ],
      },
    ];

    const result = runScreenEngine({ date, symbols: ['AAA', 'BBB', 'CCC'], screens }, db);

    expect(result.matchesByScreen.momentum_breakout).toBe(1);
    expect(result.partialByScreen.momentum_breakout).toBe(1); // BBB is 3/4
    expect(result.evaluations).toHaveLength(3);

    const persisted = db
      .prepare('SELECT symbol, screen_name AS name FROM screens WHERE date = ?')
      .all(date) as Array<{ symbol: string; name: string }>;
    expect(persisted).toEqual([{ symbol: 'AAA', name: 'momentum_breakout' }]);
  });

  it('persist=false leaves the screens table empty', () => {
    const db = getDb({ path: dbPath });
    migrate(db);

    const signal: Signal = {
      symbol: 'AAA',
      date: '2026-04-30',
      name: 'rsi_14',
      value: 60,
      source: 'technical',
    };
    db.prepare(`
      INSERT INTO signals (symbol, date, name, value, source)
      VALUES (?, ?, ?, ?, ?)
    `).run(signal.symbol, signal.date, signal.name, signal.value, signal.source);

    const screens: ScreenDefinition[] = [
      {
        name: 'simple',
        label: 'Simple',
        description: 'test',
        timeHorizon: 'short',
        criteria: [{ signal: 'rsi_14', op: 'gt', value: 50 }],
      },
    ];

    const result = runScreenEngine(
      { date: '2026-04-30', symbols: ['AAA'], screens, persist: false },
      db,
    );
    expect(result.matchesByScreen.simple).toBe(1);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM screens').get() as { n: number };
    expect(rows.n).toBe(0);
  });
});
