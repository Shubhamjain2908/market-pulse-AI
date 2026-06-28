/**
 * Deterministic Weinstein stage classification from trailing closes.
 * Mirrors the kite-portfolio skill heuristics (portfolio-analyze.mjs).
 */

/** Numeric codes stored in signals.weinstein_stage_code */
export const WEINSTEIN_STAGE = {
  INSUFFICIENT: 0,
  STAGE_1: 1,
  STAGE_2A: 21,
  STAGE_2B: 22,
  STAGE_3: 3,
  STAGE_4: 4,
} as const;

export type WeinsteinStageCode = (typeof WEINSTEIN_STAGE)[keyof typeof WEINSTEIN_STAGE];

export interface WeinsteinStageResult {
  stageCode: WeinsteinStageCode;
  stageScore: number;
  pctAboveSma200: number | null;
  sma200Slope30dPct: number | null;
}

export interface WeinsteinMasAtBar {
  sma50?: number | null;
  sma200?: number | null;
}

/** Rolling mean; uses all available bars when history < period (ponytail: same as skill script). */
function rollingMa(closes: number[], period: number): number {
  const n = closes.length;
  const window = n < period ? closes : closes.slice(-period);
  return window.reduce((a, b) => a + b, 0) / window.length;
}

export function weinsteinStageLabel(code: number): string {
  switch (code) {
    case WEINSTEIN_STAGE.STAGE_1:
      return 'Stage 1';
    case WEINSTEIN_STAGE.STAGE_2A:
      return 'Stage 2A';
    case WEINSTEIN_STAGE.STAGE_2B:
      return 'Stage 2B';
    case WEINSTEIN_STAGE.STAGE_3:
      return 'Stage 3';
    case WEINSTEIN_STAGE.STAGE_4:
      return 'Stage 4';
    default:
      return 'Insufficient data';
  }
}

export function weinsteinStageScore(code: number): number {
  switch (code) {
    case WEINSTEIN_STAGE.STAGE_2B:
      return 30;
    case WEINSTEIN_STAGE.STAGE_2A:
      return 25;
    case WEINSTEIN_STAGE.STAGE_1:
      return 15;
    case WEINSTEIN_STAGE.STAGE_3:
      return 8;
    case WEINSTEIN_STAGE.STAGE_4:
      return 0;
    default:
      return 15;
  }
}

function insufficient(): WeinsteinStageResult {
  return {
    stageCode: WEINSTEIN_STAGE.INSUFFICIENT,
    stageScore: weinsteinStageScore(WEINSTEIN_STAGE.INSUFFICIENT),
    pctAboveSma200: null,
    sma200Slope30dPct: null,
  };
}

/**
 * Classify Weinstein stage from oldest-first closes through `index` (inclusive).
 * Requires at least 50 bars for a non-insufficient read.
 */
export function computeWeinsteinStage(
  closes: number[],
  index: number,
  mas?: WeinsteinMasAtBar,
): WeinsteinStageResult {
  const slice = closes.slice(0, index + 1);
  const n = slice.length;
  if (n < 50) return insufficient();

  const closeToday = slice[n - 1];
  if (closeToday == null) return insufficient();

  const ma50 = mas?.sma50 ?? rollingMa(slice, 50);
  const ma150 = rollingMa(slice, 150);
  const ma200 = mas?.sma200 ?? rollingMa(slice, 200);

  const priorSlice = n > 30 ? slice.slice(0, n - 30) : slice;
  const ma200Prior = rollingMa(priorSlice, 200);
  const slope200 = ma200 - ma200Prior;
  const sma200Slope30dPct = ma200Prior > 0 ? (slope200 / ma200Prior) * 100 : null;
  const pctAboveSma200 = ma200 > 0 ? ((closeToday - ma200) / ma200) * 100 : null;

  const rising200 = slope200 > 0;
  const pctAbove200 = pctAboveSma200 ?? 0;
  const orderUp = closeToday > ma50 && ma50 > ma150 && ma150 > ma200;
  const orderDown = closeToday < ma50 && ma50 < ma150 && ma150 < ma200;
  const near200 = Math.abs(pctAbove200) < 5;

  let stageCode: WeinsteinStageCode;
  if (orderUp && rising200) {
    stageCode = WEINSTEIN_STAGE.STAGE_2B;
  } else if (orderDown && !rising200) {
    stageCode = WEINSTEIN_STAGE.STAGE_4;
  } else if (near200 && Math.abs(slope200 / ma200) < 0.005) {
    stageCode = WEINSTEIN_STAGE.STAGE_1;
  } else if (!rising200 && Math.abs(pctAbove200) < 8) {
    stageCode = WEINSTEIN_STAGE.STAGE_3;
  } else if (closeToday > ma200) {
    stageCode = WEINSTEIN_STAGE.STAGE_2A;
  } else {
    stageCode = WEINSTEIN_STAGE.STAGE_3;
  }

  return {
    stageCode,
    stageScore: weinsteinStageScore(stageCode),
    pctAboveSma200,
    sma200Slope30dPct,
  };
}
