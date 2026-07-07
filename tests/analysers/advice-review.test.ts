import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runAdviceReview } from '../../src/analysers/advice-review.js';
import { NIFTY_BENCHMARK_SYMBOL } from '../../src/market/benchmarks.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Seed an NSE `quotes` row. Uses INSERT OR IGNORE so shared symbol/NIFTY_50
 * rows are idempotent (avoids UNIQUE constraint on repeated seedWithBenchmark calls).
 */
function insertQuote(db: DatabaseType, symbol: string, date: string, close: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO quotes (symbol, exchange, date, open, high, low, close, volume, source)
     VALUES (?, 'NSE', ?, ?, ?, ?, ?, 1000000, 'test')`,
  ).run(symbol, date, close, close, close, close);
}

/**
 * Helper: seed a `portfolio_analysis` row.
 */
function insertAnalysis(
  db: DatabaseType,
  symbol: string,
  date: string,
  action: 'HOLD' | 'ADD' | 'TRIM' | 'EXIT',
  conviction: number = 0.6,
): void {
  db.prepare(
    `INSERT INTO portfolio_analysis (symbol, date, action, conviction, thesis, bull_points, bear_points, trigger_reason, model)
     VALUES (?, ?, ?, ?, 'thesis', '[]', '[]', 'test', 'mock')`,
  ).run(symbol, date, action, conviction);
}

/**
 * Seed quotes for a symbol on the given dates.
 * NIFTY_50 benchmark quotes are seeded separately via `seedBenchmark`.
 */
function seedSymbolQuotes(
  db: DatabaseType,
  symbol: string,
  prices: Array<{ date: string; close: number }>,
): void {
  for (const { date, close } of prices) {
    insertQuote(db, symbol, date, close);
  }
}

/** Seed NIFTY_50 quotes for the same dates as the test symbols. */
function seedBenchmark(db: DatabaseType, prices: Array<{ date: string; close: number }>): void {
  for (const { date, close } of prices) {
    insertQuote(db, NIFTY_BENCHMARK_SYMBOL, date, close);
  }
}

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

function buildFixtureDb(): DatabaseType {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE quotes (
      symbol TEXT NOT NULL,
      exchange TEXT NOT NULL DEFAULT 'NSE',
      date TEXT NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume INTEGER NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY (symbol, exchange, date)
    );
    CREATE TABLE portfolio_analysis (
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      action TEXT NOT NULL,
      conviction REAL NOT NULL,
      thesis TEXT NOT NULL,
      bull_points TEXT NOT NULL,
      bear_points TEXT NOT NULL,
      trigger_reason TEXT NOT NULL,
      model TEXT NOT NULL,
      PRIMARY KEY (symbol, date)
    );
    CREATE INDEX idx_quotes_symbol ON quotes(symbol);
  `);
  return db;
}

// ---------------------------------------------------------------------------
// Verified trading-day dates
//
// Entry:     2026-01-06 (Tue)
// 30d:  Feb 5 → Feb 5  (Thu) ✓
// 60d:  Mar 6 → Mar 6  (Fri) ✓
// 90d:  Apr 6 → Apr 6  (Mon) ✓
// ---------------------------------------------------------------------------

const ENTRY_DATE = '2026-01-06';
const HORIZON_90 = '2026-04-06';

/** Standard benchmark quote set shared across most tests. */
const BENCH_PRICES: Array<{ date: string; close: number }> = [
  { date: ENTRY_DATE, close: 5000 },
  { date: HORIZON_90, close: 5100 },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('advice-review: transition dedup', () => {
  it('collapses repeated HOLDs into a single transition per streak', () => {
    const db = buildFixtureDb();

    const dates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'];
    for (const d of dates) {
      insertQuote(db, 'TEST', d, 100);
      insertQuote(db, NIFTY_BENCHMARK_SYMBOL, d, 5000);
    }

    insertAnalysis(db, 'TEST', '2026-01-05', 'HOLD');
    insertAnalysis(db, 'TEST', '2026-01-06', 'HOLD');
    insertAnalysis(db, 'TEST', '2026-01-07', 'TRIM');
    insertAnalysis(db, 'TEST', '2026-01-08', 'TRIM');
    insertAnalysis(db, 'TEST', '2026-01-09', 'ADD');

    const result = runAdviceReview({ date: '2026-01-09', db });

    expect(result.totalCalls).toBe(5);
    expect(result.scoredTransitions).toBe(3);

    expect(result.byAction.HOLD?.transitions).toBe(1);
    expect(result.byAction.TRIM?.transitions).toBe(1);
    expect(result.byAction.ADD?.transitions).toBe(1);
  });
});

describe('advice-review: correctness rules', () => {
  it('EXIT is correct when stock underperforms NIFTY (x90 < 0)', () => {
    const db = buildFixtureDb();

    // Stock -10%, NIFTY -2% → x90 ≈ -8% < 0 → correct EXIT
    seedSymbolQuotes(db, 'EXITCO', [
      { date: ENTRY_DATE, close: 100 },
      { date: HORIZON_90, close: 90 },
    ]);
    seedBenchmark(db, [
      { date: ENTRY_DATE, close: 5000 },
      { date: HORIZON_90, close: 4900 },
    ]);

    insertAnalysis(db, 'EXITCO', ENTRY_DATE, 'EXIT', 0.7);

    const result = runAdviceReview({ date: HORIZON_90, db });
    const exitStats = result.byAction.EXIT;
    expect(exitStats?.scorable).toBe(1);
    expect(exitStats?.correct).toBe(1);
    expect(exitStats?.hitRate).toBe(1);
  });

  it('HOLD is incorrect when stock lags NIFTY beyond -5% (x90 <= -5)', () => {
    const db = buildFixtureDb();

    // Stock -12%, NIFTY -2% → x90 ≈ -10% < -5 → incorrect HOLD
    seedSymbolQuotes(db, 'LAGCO', [
      { date: ENTRY_DATE, close: 100 },
      { date: HORIZON_90, close: 88 },
    ]);
    seedBenchmark(db, [
      { date: ENTRY_DATE, close: 5000 },
      { date: HORIZON_90, close: 4900 },
    ]);

    insertAnalysis(db, 'LAGCO', ENTRY_DATE, 'HOLD', 0.6);

    const result = runAdviceReview({ date: HORIZON_90, db });
    const holdStats = result.byAction.HOLD;
    expect(holdStats?.scorable).toBe(1);
    expect(holdStats?.correct).toBe(0);
    expect(holdStats?.hitRate).toBe(0);
  });

  it('ADD is correct when stock outperforms NIFTY (x90 > 0)', () => {
    const db = buildFixtureDb();

    // Stock +10%, NIFTY +3% → x90 ≈ +7% > 0 → correct ADD
    seedSymbolQuotes(db, 'UPCO', [
      { date: ENTRY_DATE, close: 100 },
      { date: HORIZON_90, close: 110 },
    ]);
    seedBenchmark(db, [
      { date: ENTRY_DATE, close: 5000 },
      { date: HORIZON_90, close: 5150 },
    ]);

    insertAnalysis(db, 'UPCO', ENTRY_DATE, 'ADD', 0.8);

    const result = runAdviceReview({ date: HORIZON_90, db });
    const addStats = result.byAction.ADD;
    expect(addStats?.scorable).toBe(1);
    expect(addStats?.correct).toBe(1);
  });

  it('TRIM is correct when stock underperforms NIFTY (x90 < 0)', () => {
    const db = buildFixtureDb();

    // Stock flat (0%), NIFTY +5% → excess return = -5% < 0 → correct TRIM
    seedSymbolQuotes(db, 'FLATCO', [
      { date: ENTRY_DATE, close: 100 },
      { date: HORIZON_90, close: 100 },
    ]);
    seedBenchmark(db, [
      { date: ENTRY_DATE, close: 5000 },
      { date: HORIZON_90, close: 5250 },
    ]);

    insertAnalysis(db, 'FLATCO', ENTRY_DATE, 'TRIM', 0.5);

    const result = runAdviceReview({ date: HORIZON_90, db });
    const trimStats = result.byAction.TRIM;
    expect(trimStats?.scorable).toBe(1);
    expect(trimStats?.correct).toBe(1);
  });
});

describe('advice-review: horizon not elapsed', () => {
  it('marks horizon as pending when 90d window exceeds latest quote date', () => {
    const db = buildFixtureDb();

    // Call on Jan 6, quotes only through Jan 7
    // 90d target = Apr 6 > latest quote date (Jan 7) → pending
    seedSymbolQuotes(db, 'RECENT', [
      { date: '2026-01-06', close: 100 },
      { date: '2026-01-07', close: 101 },
    ]);
    seedBenchmark(db, [
      { date: '2026-01-06', close: 5000 },
      { date: '2026-01-07', close: 5010 },
    ]);

    insertAnalysis(db, 'RECENT', '2026-01-06', 'HOLD', 0.6);

    const result = runAdviceReview({ date: '2026-01-07', db });

    expect(result.pending).toBe(1);
    const holdStats = result.byAction.HOLD;
    expect(holdStats?.pending).toBe(1);
    expect(holdStats?.scorable).toBe(0);
    expect(holdStats?.hitRate).toBeNull();
  });
});

describe('advice-review: missing entry quote', () => {
  it('marks as unscorable_no_entry when no quote within 7 days of call', () => {
    const db = buildFixtureDb();

    // MSTCO only has a quote on Jan 6. Call on Jan 13 (Tue) — 7-day window ends Jan 20.
    // No quote within that window → unscorable
    insertQuote(db, 'MSTCO', '2026-01-06', 100);

    insertAnalysis(db, 'MSTCO', '2026-01-13', 'EXIT', 0.7);

    const result = runAdviceReview({ date: '2026-04-06', db });
    expect(result.unscorableNoEntry).toBe(1);
    const exitStats = result.byAction.EXIT;
    expect(exitStats?.transitions).toBe(1);
    expect(exitStats?.scorable).toBe(0);
  });
});

describe('advice-review: multiple symbols', () => {
  it('handles mixed actions across different symbols', () => {
    const db = buildFixtureDb();

    // ALPHA up 20% → ADD is correct
    // BETA down 15% → EXIT is correct
    seedBenchmark(db, BENCH_PRICES);
    seedSymbolQuotes(db, 'ALPHA', [
      { date: ENTRY_DATE, close: 100 },
      { date: HORIZON_90, close: 120 },
    ]);
    seedSymbolQuotes(db, 'BETA', [
      { date: ENTRY_DATE, close: 200 },
      { date: HORIZON_90, close: 170 },
    ]);

    insertAnalysis(db, 'ALPHA', ENTRY_DATE, 'ADD', 0.8);
    insertAnalysis(db, 'BETA', ENTRY_DATE, 'EXIT', 0.8);

    const result = runAdviceReview({ date: HORIZON_90, db });

    expect(result.scoredTransitions).toBe(2);
    expect(result.byAction.ADD?.scorable).toBe(1);
    expect(result.byAction.ADD?.correct).toBe(1);
    expect(result.byAction.EXIT?.scorable).toBe(1);
    expect(result.byAction.EXIT?.correct).toBe(1);
  });
});

describe('advice-review: worst calls output', () => {
  it('includes the worst-performing calls in worstCalls', () => {
    const db = buildFixtureDb();

    // GOOD +30%, BAD -30% with NIFTY +4%
    seedBenchmark(db, [
      { date: ENTRY_DATE, close: 5000 },
      { date: HORIZON_90, close: 5200 },
    ]);
    seedSymbolQuotes(db, 'GOOD', [
      { date: ENTRY_DATE, close: 100 },
      { date: HORIZON_90, close: 130 },
    ]);
    seedSymbolQuotes(db, 'BAD', [
      { date: ENTRY_DATE, close: 100 },
      { date: HORIZON_90, close: 70 },
    ]);

    insertAnalysis(db, 'GOOD', ENTRY_DATE, 'ADD', 0.7);
    insertAnalysis(db, 'BAD', ENTRY_DATE, 'ADD', 0.7);

    const result = runAdviceReview({ date: HORIZON_90, db });

    expect(result.worstCalls.length).toBe(2);
    // BAD has most negative x90 → first
    expect(result.worstCalls[0]?.symbol).toBe('BAD');
    expect(result.worstCalls[1]?.symbol).toBe('GOOD');
  });
});

describe('advice-review: console output', () => {
  it('printAdviceReview produces output without throwing', async () => {
    const db = buildFixtureDb();

    seedBenchmark(db, BENCH_PRICES);
    seedSymbolQuotes(db, 'CONSOLE', [
      { date: ENTRY_DATE, close: 100 },
      { date: HORIZON_90, close: 105 },
    ]);

    insertAnalysis(db, 'CONSOLE', ENTRY_DATE, 'HOLD', 0.6);

    const result = runAdviceReview({ date: HORIZON_90, db });

    const { printAdviceReview } = await import('../../src/analysers/advice-review.js');
    expect(() => printAdviceReview(result, false)).not.toThrow();
    expect(() => printAdviceReview(result, true)).not.toThrow();
  });
});

describe('advice-review: horizon quote walk-back', () => {
  it('walks back to find quote when exact horizon date has no quote', () => {
    const db = buildFixtureDb();

    // Stock has quote on Apr 2 (Thu) but NOT on Apr 6 (Mon — the 90d target).
    // Apr 7 makes latestQd > targetDate so the 90d horizon is elapsed;
    // getCloseOnOrBefore walks back from Apr 6: Apr 5 (Sun) → lastOpenOnOrBefore
    // returns Apr 2. Stock quote found on Apr 2.
    // NIFTY also seeded on Apr 2 so benchmark close resolves the same way.
    const entryDate = '2026-01-06';
    seedSymbolQuotes(db, 'WALKCO', [
      { date: entryDate, close: 100 },
      { date: '2026-04-02', close: 110 }, // prior close (walk-back target)
      { date: '2026-04-07', close: 112 }, // after horizon — makes 90d elapsed
    ]);
    seedBenchmark(db, [
      { date: entryDate, close: 5000 },
      { date: '2026-04-02', close: 5100 }, // benchmark close within walk-back window
      { date: '2026-04-07', close: 5150 },
    ]);

    insertAnalysis(db, 'WALKCO', entryDate, 'HOLD', 0.6);

    const result = runAdviceReview({ date: '2026-04-07', db });

    // Walk-back finds Apr 2 quote for both stock and benchmark
    // Stock: (110-100)/100 = +10%, NIFTY: (5100-5000)/5000 = +2%
    // x90: +10% - 2% = +8% > -5 → correct HOLD
    const holdStats = result.byAction.HOLD;
    expect(holdStats?.scorable).toBe(1);
    expect(holdStats?.correct).toBe(1);
    expect(result.unscorableNoHorizon).toBe(0);
  });

  it('reports unscorableNoHorizon when walk-back limit is exhausted', () => {
    const db = buildFixtureDb();

    // Stock has entry quote on Jan 6 and a post-horizon quote on Apr 7 (so 90d
    // is elapsed), but NO quote between Jan 6 and Apr 6 (the 90d target).
    // Walk-back of 10 sessions from Apr 6 can't reach Jan 6 → unscorableNoHorizon.
    // NIFTY IS seeded on the exact horizon date (Apr 6) so benchmark resolves
    // but stock doesn't, isolating the test to stock walk-back exhaustion.
    const entryDate = '2026-01-06';
    seedSymbolQuotes(db, 'GAPCO', [
      { date: entryDate, close: 100 },
      // Apr 7 makes latestQd > 90d target so horizon is elapsed
      { date: '2026-04-07', close: 105 },
    ]);
    seedBenchmark(db, [
      { date: entryDate, close: 5000 },
      { date: '2026-04-06', close: 5100 }, // benchmark on exact 90d target
      { date: '2026-04-07', close: 5150 },
    ]);

    insertAnalysis(db, 'GAPCO', entryDate, 'HOLD', 0.6);

    const result = runAdviceReview({ date: '2026-04-07', db });

    // 90d horizon is elapsed (Apr 6 <= Apr 7), but stock has no quote within
    // 10-session walk-back of Apr 6 → x90 null → unscorableNoHorizon.
    // Benchmark resolves normally (NIFTY has Apr 6 quote).
    expect(result.unscorableNoHorizon).toBe(1);
    const holdStats = result.byAction.HOLD;
    expect(holdStats?.scorable).toBe(0);
    expect(holdStats?.unscorableNoHorizon).toBe(1);
    expect(holdStats?.correct).toBe(0);
    expect(holdStats?.hitRate).toBeNull();
  });

  it('reports unscorableNoHorizon when walk-back limit is exhausted', () => {
    const db = buildFixtureDb();

    // Stock has entry quote on Jan 6 and a post-horizon quote on Apr 7 (so 90d
    // is elapsed), but NO quote between Jan 6 and Apr 6 (the 90d target).
    // Walk-back of 10 sessions from Apr 6 can't reach Jan 6 → unscorableNoHorizon.
    const entryDate = '2026-01-06';
    seedSymbolQuotes(db, 'GAPCO', [
      { date: entryDate, close: 100 },
      // Apr 7 makes latestQd > 90d target so horizon is elapsed
      { date: '2026-04-07', close: 105 },
    ]);
    seedBenchmark(db, [
      { date: entryDate, close: 5000 },
      { date: '2026-04-07', close: 5100 },
    ]);

    insertAnalysis(db, 'GAPCO', entryDate, 'HOLD', 0.6);

    const result = runAdviceReview({ date: '2026-04-07', db });

    // 90d horizon is elapsed (Apr 6 <= Apr 7), but no quote within 10-session
    // walk-back of Apr 6 → x90 null → unscorableNoHorizon
    expect(result.unscorableNoHorizon).toBe(1);
    const holdStats = result.byAction.HOLD;
    expect(holdStats?.scorable).toBe(0);
    expect(holdStats?.unscorableNoHorizon).toBe(1);
    expect(holdStats?.correct).toBe(0);
    expect(holdStats?.hitRate).toBeNull();
  });
});
