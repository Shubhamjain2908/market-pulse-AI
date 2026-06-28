import { describe, expect, it } from 'vitest';
import {
  buildPortfolioStructureContext,
  enrichActionWithStructureContext,
  formatStageStructureLine,
} from '../../src/agents/portfolio-structure.js';
import { WEINSTEIN_STAGE } from '../../src/enrichers/technical/weinstein-stage.js';

describe('portfolio-structure', () => {
  it('builds accumulate_on_pullback for Stage 2B', () => {
    const ctx = buildPortfolioStructureContext({
      weinstein_stage_code: WEINSTEIN_STAGE.STAGE_2B,
      weinstein_stage_score: 30,
      pct_above_sma200: 6.2,
      sma200_slope_30d_pct: 0.8,
      rsi_14: 72,
      pct_from_52w_high: -2,
    });
    expect(ctx).not.toBeNull();
    if (!ctx) return;
    expect(ctx.qualityBias).toBe('accumulate_on_pullback');
    expect(ctx.timingState).toBe('extended');
    expect(formatStageStructureLine(ctx, 'HOLD')).toContain('HOLD, not ADD here');
  });

  it('enriches HOLD with structural note when quality is strong', () => {
    const out = enrichActionWithStructureContext(
      {
        action: 'HOLD',
        thesis: 'Base thesis',
        triggerReason: 'Near 52W high',
        bullPoints: [],
      },
      {
        weinstein_stage_code: WEINSTEIN_STAGE.STAGE_2B,
        weinstein_stage_score: 30,
        pct_above_sma200: 4,
        rsi_14: 75,
        pct_from_52w_high: -2,
      },
    );
    expect(out.triggerReason).toContain('structurally strong');
    expect(out.bullPoints[0]).toMatch(/Stage 2B/);
    expect(out.thesis).toBe('Base thesis');
    expect(out.thesis).not.toContain('quality_bias');
  });
});
