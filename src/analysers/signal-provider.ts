/**
 * SignalProvider abstracts "give me the value of signal X for symbol Y on
 * date Z". Screens reference signals by flat name (e.g. "rsi_14",
 * "debt_to_equity", "fii_net_streak_days") and don't care which underlying
 * table holds them.
 *
 * The default `DbSignalProvider` resolves names from three sources:
 *   1. `signals` table — technical indicators emitted by TechnicalEnricher
 *      (rsi_14, sma_50, close, volume_ratio_20d, pct_from_52w_high, ...)
 *   2. `fundamentals` table — most recent fundamentals row (pe, pb, peg,
 *      roe, roce, debt_to_equity, revenue_growth_yoy, profit_growth_yoy,
 *      promoter_holding_pct, promoter_holding_change_qoq, dividend_yield,
 *      market_cap, dividend_yield)
 *   3. Computed flow signals derived on the fly from `fii_dii`:
 *      - fii_net (today)
 *      - dii_net (today)
 *      - fii_net_5d_sum (sum of last 5 sessions)
 *      - dii_net_5d_sum (same for DIIs)
 *      - fii_net_streak_days (consecutive sessions with FII net > 0)
 *
 * Per-symbol-per-date data is loaded once and cached, so a screen with N
 * criteria triggers at most one DB hit per source.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { getDb } from '../db/index.js';
import { FlowSignalReader, isFlowSignal } from './flow-signals.js';
import {
  FundamentalSignalReader,
  isFundamentalSignal,
  normalizeFundamentalForScreen,
} from './fundamental-signals.js';
import { TechnicalSignalReader } from './technical-signals.js';

export { normalizeFundamentalForScreen };

export interface SignalProvider {
  /** Returns the value, or null if the signal isn't available. */
  get(symbol: string, date: string, signal: string): number | null;
}

export class DbSignalProvider implements SignalProvider {
  private readonly technical: TechnicalSignalReader;
  private readonly fundamentals: FundamentalSignalReader;
  private readonly flow: FlowSignalReader;

  constructor(db: DatabaseType = getDb()) {
    this.technical = new TechnicalSignalReader(db);
    this.fundamentals = new FundamentalSignalReader(db);
    this.flow = new FlowSignalReader(db);
  }

  get(symbol: string, date: string, signal: string): number | null {
    if (isFundamentalSignal(signal)) {
      return this.fundamentals.get(symbol, signal);
    }
    if (isFlowSignal(signal)) {
      return this.flow.get(date, signal);
    }
    return this.technical.get(symbol, date, signal);
  }
}

/**
 * Test-only helper — wraps a plain map of (signal -> value) so tests can
 * exercise the evaluator without a DB.
 */
export class StaticSignalProvider implements SignalProvider {
  constructor(private readonly values: Record<string, number | null | undefined>) {}
  get(_symbol: string, _date: string, signal: string): number | null {
    const v = this.values[signal];
    return v == null ? null : v;
  }
}
