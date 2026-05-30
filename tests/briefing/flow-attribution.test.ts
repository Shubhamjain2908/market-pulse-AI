import { describe, expect, it } from 'vitest';
import { classifyFlowAttribution } from '../../src/briefing/composer.js';
import { renderRegimeCard } from '../../src/briefing/regime-card.js';
import type { RegimeRow } from '../../src/types/regime.js';

describe('classifyFlowAttribution', () => {
  it('INSTITUTIONAL_ROTATION when FII deeply negative and DII positive', () => {
    const r = classifyFlowAttribution({ fiiNetSum: -600, diiNetSum: 350, sessionCount: 5 });
    expect(r).not.toBeNull();
    expect(r?.label).toContain('Institutional rotation');
    expect(r?.narrative).toContain('FII');
  });

  it('BROAD_EXIT when both sleeves net sell', () => {
    const r = classifyFlowAttribution({ fiiNetSum: -600, diiNetSum: -250, sessionCount: 5 });
    expect(r?.label).toContain('Broad exit');
  });

  it('FII_ACCUMULATION when FII positive and DII negative', () => {
    const r = classifyFlowAttribution({ fiiNetSum: 600, diiNetSum: -50, sessionCount: 5 });
    expect(r?.label).toContain('FII accumulation');
  });

  it('suppresses BALANCED (no block in briefing)', () => {
    expect(classifyFlowAttribution({ fiiNetSum: 100, diiNetSum: 100, sessionCount: 5 })).toBeNull();
  });

  it('suppresses when fewer than 3 cash sessions', () => {
    expect(
      classifyFlowAttribution({ fiiNetSum: -600, diiNetSum: 350, sessionCount: 2 }),
    ).toBeNull();
  });

  it('caveats partial window when 3–4 sessions', () => {
    const r = classifyFlowAttribution({ fiiNetSum: -600, diiNetSum: 350, sessionCount: 3 });
    expect(r?.narrative).toMatch(/^Based on 3 cash sessions/);
  });
});

describe('renderRegimeCard flow block placement', () => {
  const row: RegimeRow = {
    date: '2026-05-05',
    regime: 'BEAR_TRENDING',
    scoreTotal: -6,
    scoreTrend: 0,
    scoreVix: 0,
    scoreFii: -2,
    scoreBreadth: -2,
    vixValue: 18,
    niftyVsSma200: -1,
    fii20dNet: -1000,
    adRatio: 0.8,
    pctAboveSma200: 40,
    crisisOverride: false,
    narrative: 'Stored regime narrative.',
    prevRegime: 'CHOPPY',
    regimeAge: 2,
  };

  it('inserts flow attribution between score tiles and regime narrative', () => {
    const html = renderRegimeCard(
      row,
      { active: [], totalRows: 4 },
      {
        label: 'Institutional rotation — foreigners net sellers, domestic buyers absorbing.',
        narrative: 'FII +₹0, DII +₹0 (5-session cash).',
      },
    );
    const tilesIdx = html.indexOf('regime-tiles-table');
    const flowIdx = html.indexOf('aria-label="FII/DII flow attribution"');
    const narrativeIdx = html.indexOf('Stored regime narrative.');
    const gateIdx = html.indexOf('regime-gate-summary');
    expect(tilesIdx).toBeGreaterThan(-1);
    expect(flowIdx).toBeGreaterThan(tilesIdx);
    expect(narrativeIdx).toBeGreaterThan(flowIdx);
    expect(gateIdx).toBeGreaterThan(narrativeIdx);
  });
});
