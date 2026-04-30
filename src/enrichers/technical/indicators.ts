/**
 * Pure-math technical indicators. No SQL, no IO - just number-in,
 * number-out functions so they're trivially testable and obviously correct.
 *
 * Convention: input arrays are oldest-first (input[0] is the earliest day).
 * Output arrays have the same length as the input; values that can't be
 * computed yet (insufficient lookback) are `null`.
 */

export interface Ohlc {
  high: number;
  low: number;
  close: number;
}

export interface Bar extends Ohlc {
  volume: number;
}

/** Simple moving average. */
export function sma(values: number[], period: number): (number | null)[] {
  if (period <= 0) throw new Error('period must be > 0');
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] ?? 0;
    if (i >= period) sum -= values[i - period] ?? 0;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average. Seeded with the SMA of the first `period`
 * values, then EMA[i] = (close[i] * k) + (EMA[i-1] * (1 - k)).
 */
export function ema(values: number[], period: number): (number | null)[] {
  if (period <= 0) throw new Error('period must be > 0');
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i] ?? 0;
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = ((values[i] ?? 0) - prev) * k + prev;
    out[i] = prev;
  }
  return out;
}

/**
 * Wilder's RSI. First avg gain/loss is the simple average of the first
 * `period` gains/losses; subsequent values use Wilder's smoothing
 * (avg = (prevAvg * (n-1) + current) / n).
 */
export function rsi(values: number[], period = 14): (number | null)[] {
  if (period <= 0) throw new Error('period must be > 0');
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = (values[i] ?? 0) - (values[i - 1] ?? 0);
    if (change >= 0) gainSum += change;
    else lossSum -= change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = computeRsi(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const change = (values[i] ?? 0) - (values[i - 1] ?? 0);
    const gain = Math.max(0, change);
    const loss = Math.max(0, -change);
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = computeRsi(avgGain, avgLoss);
  }
  return out;
}

function computeRsi(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Wilder's ATR. Uses true range = max(high-low, |high-prevClose|,
 * |low-prevClose|), then Wilder smoothing as in RSI.
 */
export function atr(bars: Ohlc[], period = 14): (number | null)[] {
  if (period <= 0) throw new Error('period must be > 0');
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length <= period) return out;

  const tr: number[] = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i];
    const prev = bars[i - 1];
    if (!cur || !prev) continue;
    tr[i] = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
  }

  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i] ?? 0;
  let prevAtr = sum / period;
  out[period] = prevAtr;

  for (let i = period + 1; i < bars.length; i++) {
    prevAtr = (prevAtr * (period - 1) + (tr[i] ?? 0)) / period;
    out[i] = prevAtr;
  }
  return out;
}

/**
 * Volume ratio = today's volume / SMA of the previous `period` volumes
 * (excluding today). >2 typically flags unusual trading activity.
 */
export function volumeRatio(volumes: number[], period = 20): (number | null)[] {
  const out: (number | null)[] = new Array(volumes.length).fill(null);
  if (volumes.length <= period) return out;
  for (let i = period; i < volumes.length; i++) {
    let sum = 0;
    for (let j = i - period; j < i; j++) sum += volumes[j] ?? 0;
    const avg = sum / period;
    if (avg > 0) out[i] = (volumes[i] ?? 0) / avg;
  }
  return out;
}

export interface FiftyTwoWeek {
  high: number;
  low: number;
  pctFromHigh: number;
  pctFromLow: number;
}

/**
 * 52-week high/low using a trailing-window of `lookback` bars (252 trading
 * days ≈ 1 year). Returns null if we don't have enough history.
 */
export function fiftyTwoWeek(bars: Ohlc[], lookback = 252): FiftyTwoWeek | null {
  if (bars.length === 0) return null;
  const window = bars.slice(-lookback);
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  for (const b of window) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
  }
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  const last = bars[bars.length - 1];
  if (!last) return null;
  return {
    high,
    low,
    pctFromHigh: ((last.close - high) / high) * 100,
    pctFromLow: ((last.close - low) / low) * 100,
  };
}
