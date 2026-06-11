import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockComputeRegimeSignals = vi.hoisted(() => vi.fn());

vi.mock('../../src/enrichers/regime-signals.js', () => ({
  computeRegimeSignals: mockComputeRegimeSignals,
}));

import { isCompleteRegimeNarrative, runRegimeAgent } from '../../src/agents/regime-agent.js';
import { migrate } from '../../src/db/migrate.js';
import { getTodayRegime } from '../../src/db/regime-queries.js';
import { resetLlmProvider, setLlmProvider } from '../../src/llm/factory.js';
import { MockLlmProvider } from '../../src/llm/providers/mock.js';
import type { RegimeSignals } from '../../src/types/regime.js';

function fullRegimeSignals(date: string, partial: Partial<RegimeSignals> = {}): RegimeSignals {
  return {
    date,
    niftyVsSma200Pct: 2.5,
    sma200Slope10dPct: 0.2,
    vixCurrent: 15,
    vix5dChangePct: 1.2,
    fii20dRollingCr: 1200,
    fii5dTrend: 'POSITIVE',
    adRatio: 1.4,
    pctAboveSma200: 55,
    niftyGapPct: 0.1,
    scoreNiftySma: 1,
    scoreSma200Slope: 1,
    scoreVixLevel: 1,
    scoreVix5d: 0,
    scoreFii20d: 1,
    scoreFii5dTrend: 0,
    scoreAdRatio: 0,
    scorePctAboveSma200: 1,
    scoreTrend: 2,
    scoreVix: 1,
    scoreFii: 1,
    scoreBreadth: 1,
    scoreTotal: 2,
    warnings: [],
    ...partial,
  };
}

describe('runRegimeAgent', () => {
  beforeEach(() => {
    mockComputeRegimeSignals.mockReset();
    mockComputeRegimeSignals.mockImplementation((_db, date) => fullRegimeSignals(date));
    resetLlmProvider();
    setLlmProvider(new MockLlmProvider());
  });

  afterEach(() => {
    resetLlmProvider();
  });

  it('writes regime_daily with mock LLM narrative JSON', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const out = await runRegimeAgent({}, db);
    const row = getTodayRegime(out.sessionDate, db);
    expect(row).toBeTruthy();
    expect(row?.narrative).toMatch(/Mock regime line:|VIX/);
    expect(typeof out.changed).toBe('boolean');
    expect(out.usedFallbackNarrative).toBe(false);
    db.close();
  });

  it('skipLlm uses templated fallback and still persists', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const out = await runRegimeAgent({ skipLlm: true }, db);
    const row = getTodayRegime(out.sessionDate, db);
    expect(row?.narrative).toMatch(/^Regime: /);
    expect(out.usedFallbackNarrative).toBe(true);
    db.close();
  });

  it('isCompleteRegimeNarrative rejects truncated sentences', () => {
    expect(
      isCompleteRegimeNarrative('The market remains choppy, with strong breadth (A/D ratio 3.7'),
    ).toBe(false);
    expect(
      isCompleteRegimeNarrative(
        'The market remains choppy, with strong breadth (A/D ratio 3.7) and steady flows.',
      ),
    ).toBe(true);
  });
});
