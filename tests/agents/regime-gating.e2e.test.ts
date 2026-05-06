/**
 * Phase 4 regime gating — integration checks against SQLite + gate seed data.
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { generateTheses } from '../../src/agents/thesis-generator.js';
import { runScreenEngine } from '../../src/analysers/engine.js';
import { loadStrategyGates } from '../../src/config/loaders.js';
import { migrate } from '../../src/db/migrate.js';
import {
  getSizeMultiplier,
  isStrategyAllowed,
  seedStrategyGates,
} from '../../src/db/regime-queries.js';
import { resetLlmProvider, setLlmProvider } from '../../src/llm/factory.js';
import { MockLlmProvider } from '../../src/llm/providers/mock.js';
import type { ScreenDefinition } from '../../src/types/domain.js';

describe('regime gating (Phase 4)', () => {
  afterEach(() => {
    resetLlmProvider();
  });

  it('4.5 portfolio_exit_signals + trailing_stop_update stay allowed at full size in CRISIS', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedStrategyGates(loadStrategyGates({ fresh: true }).rows, db);
    expect(isStrategyAllowed('portfolio_exit_signals', 'CRISIS', db)).toBe(true);
    expect(isStrategyAllowed('trailing_stop_update', 'CRISIS', db)).toBe(true);
    expect(getSizeMultiplier('portfolio_exit_signals', 'CRISIS', db)).toBe(1);
    expect(getSizeMultiplier('trailing_stop_update', 'CRISIS', db)).toBe(1);
    db.close();
  });

  it('CRISIS: every configured screen is gated — no evaluations, no screen rows', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedStrategyGates(loadStrategyGates({ fresh: true }).rows, db);

    const screens: ScreenDefinition[] = [
      {
        name: 'momentum_breakout',
        label: 'Momentum Breakout',
        description: 't',
        timeHorizon: 'short',
        criteria: [{ signal: 'rsi_14', op: 'gt', value: 50 }],
      },
      {
        name: 'quality_at_value',
        label: 'Quality',
        description: 't',
        timeHorizon: 'long',
        criteria: [{ signal: 'rsi_14', op: 'gt', value: 40 }],
      },
    ];

    const date = '2026-06-01';
    db.prepare(
      `INSERT INTO signals (symbol, date, name, value, source) VALUES ('AAA', ?, 'rsi_14', 60, 'technical')`,
    ).run(date);

    const result = runScreenEngine({ date, symbols: ['AAA'], screens, regime: 'CRISIS' }, db);
    expect(result.evaluations).toHaveLength(0);
    const n = db.prepare('SELECT COUNT(*) AS n FROM screens WHERE date = ?').get(date) as {
      n: number;
    };
    expect(n.n).toBe(0);
    db.close();
  });

  it('BEAR_TRENDING: momentum_breakout gated; quality_at_value persists __regime_meta 0.25', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedStrategyGates(loadStrategyGates({ fresh: true }).rows, db);

    const date = '2026-06-02';
    /** DbSignalProvider reads fundamental columns from `fundamentals`, not `signals`. */
    db.prepare(
      `INSERT INTO fundamentals (symbol, as_of, roe, profit_growth_yoy, debt_to_equity, pe, source)
       VALUES ('AAA', ?, 16, 12, 0.5, 20, 'test')`,
    ).run(date);

    const screens: ScreenDefinition[] = [
      {
        name: 'momentum_breakout',
        label: 'Momentum Breakout',
        description: 't',
        timeHorizon: 'short',
        criteria: [{ signal: 'rsi_14', op: 'gt', value: 50 }],
      },
      {
        name: 'quality_at_value',
        label: 'Quality',
        description: 't',
        timeHorizon: 'long',
        criteria: [
          { signal: 'roe', op: 'gte', value: 15 },
          { signal: 'profit_growth_yoy', op: 'gte', value: 10 },
          { signal: 'debt_to_equity', op: 'lte', value: 1 },
          { signal: 'pe', op: 'lte', value: 35 },
        ],
      },
    ];

    db.prepare(
      `INSERT INTO signals (symbol, date, name, value, source) VALUES ('AAA', ?, 'rsi_14', 60, 'technical')`,
    ).run(date);

    const result = runScreenEngine(
      { date, symbols: ['AAA'], screens, regime: 'BEAR_TRENDING' },
      db,
    );
    expect(result.matchesByScreen.momentum_breakout).toBe(0);
    expect(result.matchesByScreen.quality_at_value).toBe(1);

    const row = db
      .prepare(
        `SELECT matched_criteria AS mc FROM screens WHERE date = ? AND screen_name = 'quality_at_value'`,
      )
      .get(date) as { mc: string };
    expect(row).toBeTruthy();
    const parsed = JSON.parse(row.mc) as {
      criteria: unknown[];
      __regime_meta: { sizeMultiplier: number; regime: string };
    };
    expect(parsed.__regime_meta.regime).toBe('BEAR_TRENDING');
    expect(parsed.__regime_meta.sizeMultiplier).toBe(0.25);
    db.close();
  });

  it('CRISIS: ai_picks_generation gated — zero theses without ranking', async () => {
    const db = new Database(':memory:');
    migrate(db);
    seedStrategyGates(loadStrategyGates({ fresh: true }).rows, db);
    const llm = new MockLlmProvider();
    setLlmProvider(llm);

    const out = await generateTheses(
      {
        date: '2026-06-03',
        watchlist: ['RELIANCE', 'TCS'],
        maxTheses: 3,
        regime: 'CRISIS',
      },
      db,
      llm,
    );

    expect(out.generated).toBe(0);
    expect(out.theses).toHaveLength(0);
    db.close();
  });
});
