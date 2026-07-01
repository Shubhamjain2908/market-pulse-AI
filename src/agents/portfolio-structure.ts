/**
 * Separates structural quality (Weinstein stage) from add timing (RSI / 52W / vol).
 */

import { WEINSTEIN_STAGE, weinsteinStageLabel } from '../enrichers/technical/weinstein-stage.js';

export type QualityBias =
  | 'accumulate_on_pullback'
  | 'hold_core'
  | 'trim_watch'
  | 'exit_watch'
  | 'neutral';

export type TimingState = 'extended' | 'pullback' | 'neutral';

export interface PortfolioStructureContext {
  stageLabel: string;
  stageCode: number;
  stageScore: number;
  qualityBias: QualityBias;
  timingState: TimingState;
  pctAboveSma200: number | null;
  sma200Slope30dPct: number | null;
}

function resolveQualityBias(stageCode: number, stageScore: number): QualityBias {
  if (stageCode === WEINSTEIN_STAGE.STAGE_4) return 'exit_watch';
  if (stageCode === WEINSTEIN_STAGE.STAGE_3) return 'trim_watch';
  if (
    stageCode === WEINSTEIN_STAGE.STAGE_2B ||
    stageCode === WEINSTEIN_STAGE.STAGE_2A ||
    stageScore >= 25
  ) {
    return 'accumulate_on_pullback';
  }
  if (stageCode === WEINSTEIN_STAGE.STAGE_1) return 'neutral';
  return 'neutral';
}

function vsSma20Pct(signals: Record<string, number>): number | undefined {
  const close = signals.close;
  const sma20 = signals.sma_20;
  if (close != null && sma20 != null && sma20 > 0) {
    return ((close - sma20) / sma20) * 100;
  }
  return undefined;
}

function resolveTimingState(signals: Record<string, number>): TimingState {
  const rsi = signals.rsi_14;
  const hi = signals.pct_from_52w_high;
  const lo = signals.pct_from_52w_low;
  const vs20 = vsSma20Pct(signals);
  if ((rsi != null && rsi > 62) || (hi != null && hi >= -3) || (vs20 != null && vs20 > 4)) {
    return 'extended';
  }
  if ((vs20 != null && vs20 < -2) || (lo != null && lo <= 8)) return 'pullback';
  if (signals.weinstein_stage_code === WEINSTEIN_STAGE.STAGE_2B && hi != null && hi < -8) {
    return 'pullback';
  }
  return 'neutral';
}

export function buildPortfolioStructureContext(
  signals: Record<string, number>,
): PortfolioStructureContext | null {
  const code = signals.weinstein_stage_code;
  if (code == null || code === WEINSTEIN_STAGE.INSUFFICIENT) return null;
  const score = signals.weinstein_stage_score ?? 0;
  return {
    stageLabel: weinsteinStageLabel(code),
    stageCode: code,
    stageScore: score,
    qualityBias: resolveQualityBias(code, score),
    timingState: resolveTimingState(signals),
    pctAboveSma200: signals.pct_above_sma200 ?? null,
    sma200Slope30dPct: signals.sma200_slope_30d_pct ?? null,
  };
}

function qualityBiasPhrase(bias: QualityBias): string | null {
  switch (bias) {
    case 'accumulate_on_pullback':
      return 'accumulate on pullbacks';
    case 'hold_core':
      return 'hold core';
    case 'trim_watch':
      return 'trim watch';
    case 'exit_watch':
      return 'exit watch';
    default:
      return null;
  }
}

/** Briefing / card line: stage + 200DMA + timing nuance. */
export function formatStageStructureLine(ctx: PortfolioStructureContext, action?: string): string {
  const parts: string[] = [ctx.stageLabel];
  if (ctx.pctAboveSma200 != null) {
    const dir = ctx.pctAboveSma200 >= 0 ? 'above' : 'below';
    parts.push(
      `${dir} 200DMA (${ctx.pctAboveSma200 >= 0 ? '+' : ''}${ctx.pctAboveSma200.toFixed(1)}%)`,
    );
  }
  if (ctx.sma200Slope30dPct != null) {
    const slopeWord =
      ctx.sma200Slope30dPct > 0.05
        ? 'rising 200DMA'
        : ctx.sma200Slope30dPct < -0.05
          ? 'falling 200DMA'
          : null;
    if (slopeWord) parts.push(slopeWord);
  }
  const bias = qualityBiasPhrase(ctx.qualityBias);
  if (bias) parts.push(bias);

  if (ctx.timingState === 'extended' && ctx.qualityBias === 'accumulate_on_pullback') {
    parts.push(action === 'HOLD' ? 'HOLD, not ADD here' : 'extended');
  } else if (ctx.timingState === 'extended') {
    parts.push('extended');
  } else if (ctx.timingState === 'pullback' && ctx.qualityBias === 'accumulate_on_pullback') {
    parts.push('pullback zone');
  }

  return parts.join(' · ');
}

export function formatStructureContextBlock(ctx: PortfolioStructureContext): string {
  const lines = [
    `Structure: ${ctx.stageLabel} (score ${ctx.stageScore})`,
    `quality_bias=${ctx.qualityBias}`,
    `timing_state=${ctx.timingState}`,
  ];
  if (ctx.pctAboveSma200 != null) {
    lines.push(`pct_above_sma200=${ctx.pctAboveSma200.toFixed(2)}`);
  }
  if (ctx.sma200Slope30dPct != null) {
    lines.push(`sma200_slope_30d_pct=${ctx.sma200Slope30dPct.toFixed(3)}`);
  }
  lines.push(
    'Note: structural strength (Stage 2) can coexist with HOLD when timing guardrails block ADD.',
  );
  return lines.join('\n');
}

export interface PortfolioActionLike {
  action: string;
  thesis: string;
  triggerReason: string;
  bullPoints: string[];
}

/** Append structure nuance when a name is structurally strong but action stays HOLD. */
export function enrichActionWithStructureContext<T extends PortfolioActionLike>(
  action: T,
  signals: Record<string, number>,
): T {
  const ctx = buildPortfolioStructureContext(signals);
  if (!ctx) return action;

  const structureLine = formatStageStructureLine(ctx, action.action);
  // structure lives on position-tech; thesis stays LLM prose only.

  let triggerReason = action.triggerReason;
  if (
    action.action === 'HOLD' &&
    ctx.qualityBias === 'accumulate_on_pullback' &&
    !triggerReason.includes('structurally strong')
  ) {
    const note =
      ctx.timingState === 'extended'
        ? `[Structure: ${ctx.stageLabel} — structurally strong; timing extended — accumulate on pullbacks, not ADD here.]`
        : `[Structure: ${ctx.stageLabel} — structurally strong; ${structureLine}.]`;
    triggerReason = `${triggerReason} ${note}`;
    if (triggerReason.length > 280) triggerReason = `${triggerReason.slice(0, 276)}…`;
  }

  const bullPoints = [...action.bullPoints];
  if (
    ctx.qualityBias === 'accumulate_on_pullback' &&
    !bullPoints.some((b) => /Stage 2|structurally/i.test(b))
  ) {
    bullPoints.unshift(`${ctx.stageLabel} — structurally strong holding; prefer adds on pullbacks`);
  }

  return { ...action, triggerReason, bullPoints };
}
