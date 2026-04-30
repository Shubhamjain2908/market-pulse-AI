/**
 * TechnicalEnricher reads each symbol's recent quote history from SQLite,
 * computes the 8 indicators we care about, and writes one row per signal
 * into the `signals` table.
 *
 * Signals emitted (per symbol per date):
 *   sma_20, sma_50, sma_200
 *   ema_9, ema_21
 *   rsi_14
 *   atr_14
 *   volume_ratio_20d
 *   pct_from_52w_high, pct_from_52w_low
 *   close (mirrored so screen-engine cross-comparisons like
 *   `close > sma_50` are simple lookups)
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { getDb, upsertSignals } from '../../db/index.js';
import { child } from '../../logger.js';
import type { RawQuote, Signal } from '../../types/domain.js';
import { type Bar, atr, ema, fiftyTwoWeek, rsi, sma, volumeRatio } from './indicators.js';

const log = child({ component: 'technical-enricher' });

export interface TechnicalEnricherOptions {
  /** Lookback window in trading days. Default 260 (~52 weeks + buffer). */
  lookback?: number;
  /** When set, only compute signals for bars on or before this date. */
  asOfDate?: string;
}

export interface EnricherStats {
  symbolsProcessed: number;
  signalsWritten: number;
  symbolsSkipped: number;
}

export class TechnicalEnricher {
  private readonly lookback: number;
  private readonly asOfDate?: string;

  constructor(opts: TechnicalEnricherOptions = {}) {
    this.lookback = opts.lookback ?? 260;
    this.asOfDate = opts.asOfDate;
  }

  /**
   * Enrich the given symbols. Each symbol is processed independently so
   * one bad symbol can't poison the batch.
   */
  enrich(symbols: string[], db: DatabaseType = getDb()): EnricherStats {
    const stats: EnricherStats = {
      symbolsProcessed: 0,
      signalsWritten: 0,
      symbolsSkipped: 0,
    };
    const allSignals: Signal[] = [];

    for (const symbol of symbols) {
      const bars = this.loadBars(symbol, db);
      if (bars.length < 20) {
        stats.symbolsSkipped++;
        log.debug({ symbol, bars: bars.length }, 'insufficient history, skipping');
        continue;
      }
      const signals = this.computeSignalsFor(symbol, bars);
      allSignals.push(...signals);
      stats.symbolsProcessed++;
    }

    stats.signalsWritten = upsertSignals(allSignals, db);
    log.info(stats, 'technical enrichment complete');
    return stats;
  }

  private loadBars(symbol: string, db: DatabaseType): Array<RawQuote & { dateTs: number }> {
    const rows = db
      .prepare(`
        SELECT symbol, exchange, date, open, high, low, close, adj_close AS adjClose, volume, source
        FROM quotes
        WHERE symbol = ? ${this.asOfDate ? 'AND date <= ?' : ''}
        ORDER BY date ASC
        LIMIT ?
      `)
      .all(
        ...(this.asOfDate ? [symbol, this.asOfDate, this.lookback] : [symbol, this.lookback]),
      ) as Array<RawQuote & { dateTs?: number }>;
    return rows.map((r) => ({ ...r, dateTs: Date.parse(r.date) }));
  }

  /**
   * Public for testability. Returns one Signal per indicator per bar with a
   * defined value - bars with insufficient lookback are skipped.
   */
  computeSignalsFor(symbol: string, quotes: RawQuote[]): Signal[] {
    const closes = quotes.map((q) => q.close);
    const volumes = quotes.map((q) => q.volume);
    const ohlc: Bar[] = quotes.map((q) => ({
      high: q.high,
      low: q.low,
      close: q.close,
      volume: q.volume,
    }));

    const series: Record<string, (number | null)[]> = {
      sma_20: sma(closes, 20),
      sma_50: sma(closes, 50),
      sma_200: sma(closes, 200),
      ema_9: ema(closes, 9),
      ema_21: ema(closes, 21),
      rsi_14: rsi(closes, 14),
      atr_14: atr(ohlc, 14),
      volume_ratio_20d: volumeRatio(volumes, 20),
    };

    const out: Signal[] = [];
    for (let i = 0; i < quotes.length; i++) {
      const bar = quotes[i];
      if (!bar) continue;
      // Mirror close itself so screen DSL `close > sma_50` is one lookup.
      out.push({
        symbol,
        date: bar.date,
        name: 'close',
        value: bar.close,
        source: 'technical',
      });
      for (const [name, vals] of Object.entries(series)) {
        const v = vals[i];
        if (v == null || !Number.isFinite(v)) continue;
        out.push({ symbol, date: bar.date, name, value: v, source: 'technical' });
      }

      // 52-week needs the trailing window through `i`, so compute per bar.
      const window = ohlc.slice(0, i + 1);
      const fw = fiftyTwoWeek(window);
      if (fw) {
        out.push({
          symbol,
          date: bar.date,
          name: 'pct_from_52w_high',
          value: fw.pctFromHigh,
          source: 'technical',
        });
        out.push({
          symbol,
          date: bar.date,
          name: 'pct_from_52w_low',
          value: fw.pctFromLow,
          source: 'technical',
        });
      }
    }
    return out;
  }
}
