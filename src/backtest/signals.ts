/**
 * On-the-fly technical signals for Option A backtests (same math as TechnicalEnricher / indicators.ts).
 */

import {
  atr,
  fiftyTwoWeek,
  type Bar as OhlcvBar,
  rsi,
  sma,
  volumeRatio,
} from '../enrichers/technical/indicators.js';
import { computeWeinsteinStage } from '../enrichers/technical/weinstein-stage.js';

/** Bars oldest-first; typically last 252 sessions ending at D. */
export interface OHLCVBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Adjusted close when present (quotes); momentum factors prefer this over `close`. */
  adjClose?: number | null;
}

export interface BarSignals {
  sma20: number;
  sma50: number;
  sma200: number;
  rsi14: number;
  atr14: number;
  volumeRatio20d: number;
  pctFrom52wHigh: number;
  pctFrom52wLow: number;
  close: number;
  volume: number;
  /** Weinstein stage code (0-4 / 21-22) from computeWeinsteinStage. */
  weinsteinStageCode: number;
  /** Weinstein stage score (0-30) from computeWeinsteinStage. */
  weinsteinStageScore: number;
  /** % price above SMA200. Null when < 50 bars. */
  pctAboveSma200: number | null;
  /** 30-day SMA200 slope %. Null when < 50 bars. */
  sma200Slope30dPct: number | null;
}

/** Match enricher: 252 trading days for 52-week window. */
export const SIGNAL_WINDOW_LEN = 252;

/**
 * Compute indicators for the **last** bar of `bars` (must be sorted ASC by date).
 * Requires at least {@link SIGNAL_WINDOW_LEN} bars so SMA200 and 52w metrics are defined.
 */
export function computeSignalsForLastBar(bars: OHLCVBar[]): BarSignals | null {
  if (bars.length < SIGNAL_WINDOW_LEN) return null;
  const slice = bars.slice(-SIGNAL_WINDOW_LEN);
  const closes = slice.map((b) => b.close);
  const volumes = slice.map((b) => b.volume);
  const ohlc: OhlcvBar[] = slice.map((b) => ({
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(ohlc, 14);
  const volR = volumeRatio(volumes, 20);

  const i = slice.length - 1;
  const s20 = sma20[i];
  const s50 = sma50[i];
  const s200 = sma200[i];
  const r = rsi14[i];
  const a = atr14[i];
  const vr = volR[i];
  if (
    s20 == null ||
    s50 == null ||
    s200 == null ||
    r == null ||
    a == null ||
    vr == null ||
    !Number.isFinite(s20) ||
    !Number.isFinite(s50) ||
    !Number.isFinite(s200) ||
    !Number.isFinite(r) ||
    !Number.isFinite(a) ||
    !Number.isFinite(vr)
  ) {
    return null;
  }

  const lastBar = slice[i];
  if (!lastBar) return null;

  const hiLo = ohlc.slice(0, i + 1).map((b) => ({ high: b.high, low: b.low, close: b.close }));
  const fw = fiftyTwoWeek(hiLo, 252);
  if (!fw) return null;

  const stage = computeWeinsteinStage(closes, i);

  return {
    sma20: s20,
    sma50: s50,
    sma200: s200,
    rsi14: r,
    atr14: a,
    volumeRatio20d: vr,
    pctFrom52wHigh: fw.pctFromHigh,
    pctFrom52wLow: fw.pctFromLow,
    close: lastBar.close,
    volume: lastBar.volume,
    weinsteinStageCode: stage.stageCode,
    weinsteinStageScore: stage.stageScore,
    pctAboveSma200: stage.pctAboveSma200,
    sma200Slope30dPct: stage.sma200Slope30dPct,
  };
}
