import { describe, expect, it } from 'vitest';
import { renderRegimeCard, renderRegimeChangeBanner } from '../../src/briefing/regime-card.js';
import type { Regime, RegimeRow } from '../../src/types/regime.js';

function rowForRegime(regime: Regime): RegimeRow {
  const prev: Regime | null =
    regime === 'BULL_TRENDING' ? null : regime === 'CRISIS' ? 'BEAR_TRENDING' : 'CHOPPY';

  return {
    date: '2026-05-05',
    regime,
    scoreTotal:
      regime === 'CRISIS' ? -10 : regime === 'BULL_TRENDING' ? 9 : regime === 'CHOPPY' ? 0 : -6,
    scoreTrend: 1,
    scoreVix: regime === 'CRISIS' ? -2 : 0,
    scoreFii: -1,
    scoreBreadth: 0,
    vixValue: regime === 'CRISIS' ? 32 : 17.25,
    niftyVsSma200: -1.2,
    fii20dNet: -8047.9,
    adRatio: 0.74,
    pctAboveSma200: 44.2,
    crisisOverride: regime === 'CRISIS',
    narrative: `Narrative for ${regime} citing VIX ${regime === 'CRISIS' ? 32 : 17.25} and FII 20d ₹-8047.9Cr.`,
    prevRegime: prev,
    regimeAge: prev ? 1 : 4,
  };
}

const gateSummary = {
  active: [
    { strategyId: 'momentum_breakout', sizeMultiplier: 1 },
    { strategyId: 'quality_at_value', sizeMultiplier: 0.5 },
  ],
  totalRows: 8,
};

describe('regime-card HTML', () => {
  const regimes: Regime[] = ['BULL_TRENDING', 'BEAR_TRENDING', 'CHOPPY', 'CRISIS'];
  const borderByRegime: Record<Regime, string> = {
    BULL_TRENDING: '#27AE60',
    BEAR_TRENDING: '#E74C3C',
    CHOPPY: '#E67E22',
    CRISIS: '#8E44AD',
  };
  const badgeText: Record<Regime, string> = {
    BULL_TRENDING: 'BULL TRENDING',
    BEAR_TRENDING: 'BEAR TRENDING',
    CHOPPY: 'CHOPPY',
    CRISIS: 'CRISIS',
  };

  for (const regime of regimes) {
    it(`renderRegimeCard uses §7.1 palette and structure (${regime})`, () => {
      const html = renderRegimeCard(rowForRegime(regime), gateSummary);
      expect(html).toContain(`--regime-border:${borderByRegime[regime]}`);
      expect(html).toContain(badgeText[regime]);
      expect(html).toContain('Narrative for');
      expect(html).toContain('momentum_breakout');
      expect(html).toContain('Trend');
      expect(html).toContain('VIX');
    });
  }

  it('renderRegimeChangeBanner when prev_regime differs', () => {
    const r = rowForRegime('BEAR_TRENDING');
    const html = renderRegimeChangeBanner(r, { prevScoreTotal: 0.5 });
    expect(html).toContain('REGIME CHANGE');
    expect(html).toContain('CHOPPY');
    expect(html).toContain('BEAR TRENDING');
    expect(html).toContain('0.5');
    expect(html).toContain(String(r.scoreTotal));
  });

  it('renderRegimeChangeBanner empty when no change', () => {
    const r: RegimeRow = { ...rowForRegime('BULL_TRENDING'), prevRegime: 'BULL_TRENDING' };
    expect(renderRegimeChangeBanner(r)).toBe('');
  });
});
