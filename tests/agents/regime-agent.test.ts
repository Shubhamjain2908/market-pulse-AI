import type { Database as DatabaseType } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockComputeRegimeSignals = vi.hoisted(() => vi.fn());
const mockGetTodayRegime = vi.hoisted(() => vi.fn());
const mockInsertRegimeRow = vi.hoisted(() => vi.fn());

vi.mock('../../src/enrichers/regime-signals.js', () => ({
  computeRegimeSignals: mockComputeRegimeSignals,
}));

vi.mock('../../src/db/regime-queries.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/regime-queries.js')>();
  return {
    ...actual,
    getTodayRegime: mockGetTodayRegime,
    insertRegimeRow: mockInsertRegimeRow,
  };
});

import { isCompleteRegimeNarrative, runRegimeAgent } from '../../src/agents/regime-agent.js';
import { resetLlmProvider, setLlmProvider } from '../../src/llm/factory.js';
import { MockLlmProvider } from '../../src/llm/providers/mock.js';
import type { RegimeSignals } from '../../src/types/regime.js';

/** Open NSE session (2026-05-01 is Maharashtra Day holiday). */
const SESSION = '2026-04-30';
const fakeDb = {} as DatabaseType;

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
    mockGetTodayRegime.mockReset();
    mockInsertRegimeRow.mockReset();
    mockComputeRegimeSignals.mockImplementation((_db, date) => fullRegimeSignals(date));
    mockGetTodayRegime.mockReturnValue(null);
    resetLlmProvider();
    setLlmProvider(new MockLlmProvider());
  });

  afterEach(() => {
    resetLlmProvider();
  });

  it('writes regime_daily with mock LLM narrative JSON', async () => {
    const out = await runRegimeAgent({ date: SESSION }, fakeDb);
    expect(mockInsertRegimeRow).toHaveBeenCalledOnce();
    const inserted = mockInsertRegimeRow.mock.calls[0]?.[0];
    expect(inserted?.date).toBe(SESSION);
    expect(inserted?.narrative).toMatch(/Mock regime line:|VIX/);
    expect(out.sessionDate).toBe(SESSION);
    expect(out.narrative).toMatch(/Mock regime line:|VIX/);
    expect(typeof out.changed).toBe('boolean');
    expect(out.usedFallbackNarrative).toBe(false);
  });

  it('skipLlm uses templated fallback and still persists', async () => {
    const out = await runRegimeAgent({ date: SESSION, skipLlm: true }, fakeDb);
    expect(mockInsertRegimeRow).toHaveBeenCalledOnce();
    const inserted = mockInsertRegimeRow.mock.calls[0]?.[0];
    expect(inserted?.narrative).toMatch(/^Regime: /);
    expect(out.narrative).toMatch(/^Regime: /);
    expect(out.usedFallbackNarrative).toBe(true);
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
