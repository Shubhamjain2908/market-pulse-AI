import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  applyPersistence,
  computeCrisisOverride,
  computeRawRegime,
  mapScoreTotalToRegime,
} from '../../src/analysers/regime-classifier.js';
import { loadStrategyGates } from '../../src/config/loaders.js';
import { migrate } from '../../src/db/migrate.js';
import {
  getSizeMultiplier,
  getTodayRegime,
  insertRegimeRow,
  isStrategyAllowed,
  seedStrategyGates,
} from '../../src/db/regime-queries.js';
import type { RegimeSignals } from '../../src/types/regime.js';

function signals(
  partial: Partial<RegimeSignals> & Pick<RegimeSignals, 'scoreTotal'>,
): RegimeSignals {
  return {
    date: '2026-05-01',
    niftyVsSma200Pct: null,
    sma200Slope10dPct: null,
    vixCurrent: null,
    vix5dChangePct: null,
    fii20dRollingCr: null,
    fii5dTrend: 'MIXED',
    adRatio: null,
    pctAboveSma200: null,
    niftyGapPct: null,
    scoreNiftySma: 0,
    scoreSma200Slope: 0,
    scoreVixLevel: 0,
    scoreVix5d: 0,
    scoreFii20d: 0,
    scoreFii5dTrend: 0,
    scoreAdRatio: 0,
    scorePctAboveSma200: 0,
    scoreTrend: 0,
    scoreVix: 0,
    scoreFii: 0,
    scoreBreadth: 0,
    warnings: [],
    ...partial,
  };
}

describe('regime classifier (deterministic)', () => {
  it('CRISIS override when VIX = 28.1 regardless of bullish score', () => {
    const s = signals({ scoreTotal: 12, vixCurrent: 28.1 });
    expect(computeCrisisOverride(s)).toBe(true);
    expect(computeRawRegime(s)).toBe('CRISIS');
  });

  it('CRISIS override when Nifty gap = -3.1%', () => {
    const s = signals({ scoreTotal: 10, niftyGapPct: -3.1, vixCurrent: 15 });
    expect(computeCrisisOverride(s)).toBe(true);
    expect(computeRawRegime(s)).toBe('CRISIS');
  });

  /**
   * Boundary: override uses strict `vix > 28` (spec §10.2). VIX exactly 28 does **not** force CRISIS.
   */
  it('does NOT crisis-override when VIX === 28 exactly', () => {
    const s = signals({ scoreTotal: 12, vixCurrent: 28 });
    expect(computeCrisisOverride(s)).toBe(false);
    expect(mapScoreTotalToRegime(s.scoreTotal)).toBe('BULL_TRENDING');
  });

  /**
   * Boundary: gap override uses strict `gap < -3`. Gap exactly -3% does **not** force CRISIS.
   */
  it('does NOT crisis-override when gap === -3%', () => {
    const s = signals({ scoreTotal: -10, niftyGapPct: -3, vixCurrent: 18 });
    expect(computeCrisisOverride(s)).toBe(false);
  });

  it('score_total === +2.0 → BULL_TRENDING (not CHOPPY)', () => {
    expect(mapScoreTotalToRegime(2)).toBe('BULL_TRENDING');
  });

  it('score_total === -7.0 → BEAR_TRENDING', () => {
    expect(mapScoreTotalToRegime(-7)).toBe('BEAR_TRENDING');
  });

  it('all neutral scores → total 0 → CHOPPY', () => {
    expect(mapScoreTotalToRegime(0)).toBe('CHOPPY');
  });

  it('persistence: raw BULL only 2 sessions → stay CHOPPY', () => {
    const r = applyPersistence({
      crisisOverrideToday: false,
      rawScoreToday: 'BULL_TRENDING',
      rawScorePrev1: 'BULL_TRENDING',
      rawScorePrev2: 'CHOPPY',
      persistedYesterday: 'CHOPPY',
      nonCrisisOverrideStreak: 10,
    });
    expect(r).toBe('CHOPPY');
  });

  it('persistence: raw BULL three sessions → BULL_TRENDING', () => {
    const r = applyPersistence({
      crisisOverrideToday: false,
      rawScoreToday: 'BULL_TRENDING',
      rawScorePrev1: 'BULL_TRENDING',
      rawScorePrev2: 'BULL_TRENDING',
      persistedYesterday: 'CHOPPY',
      nonCrisisOverrideStreak: 10,
    });
    expect(r).toBe('BULL_TRENDING');
  });

  it('stays CRISIS when yesterday CRISIS and streak < 5', () => {
    const r = applyPersistence({
      crisisOverrideToday: false,
      rawScoreToday: 'BULL_TRENDING',
      rawScorePrev1: 'BULL_TRENDING',
      rawScorePrev2: 'BULL_TRENDING',
      persistedYesterday: 'CRISIS',
      nonCrisisOverrideStreak: 3,
    });
    expect(r).toBe('CRISIS');
  });
});

describe('regime_strategy_gate helpers', () => {
  it('momentum_breakout + BEAR_TRENDING → not allowed', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedStrategyGates(loadStrategyGates().rows, db);
    expect(isStrategyAllowed('momentum_breakout', 'BEAR_TRENDING', db)).toBe(false);
    db.close();
  });

  it('quality_at_value + CHOPPY → size multiplier 0.5 (maps spec quality_garp)', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedStrategyGates(loadStrategyGates().rows, db);
    expect(getSizeMultiplier('quality_at_value', 'CHOPPY', db)).toBe(0.5);
    db.close();
  });

  it('getTodayRegime round-trip after insertRegimeRow', () => {
    const db = new Database(':memory:');
    migrate(db);
    insertRegimeRow(
      {
        date: '2026-05-02',
        regime: 'CHOPPY',
        scoreTotal: 0,
        scoreTrend: 0,
        scoreVix: 0,
        scoreFii: 0,
        scoreBreadth: 0,
        vixValue: 18,
        niftyVsSma200: 0,
        fii20dNet: 0,
        adRatio: 1,
        pctAboveSma200: 50,
        crisisOverride: false,
        narrative: null,
        prevRegime: 'BULL_TRENDING',
        regimeAge: 3,
      },
      db,
    );
    const row = getTodayRegime('2026-05-02', db);
    expect(row?.regime).toBe('CHOPPY');
    expect(row?.prevRegime).toBe('BULL_TRENDING');
    expect(row?.regimeAge).toBe(3);
    db.close();
  });
});
