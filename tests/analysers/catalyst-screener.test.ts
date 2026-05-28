import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runCatalystScreener } from '../../src/analysers/catalyst-screener.js';
import { recordPaperTrades } from '../../src/briefing/paper-trade-writer.js';
import type { ThesisCard } from '../../src/briefing/template.js';
import { migrate } from '../../src/db/migrate.js';

const AS_OF = '2026-05-01';

function seedCatalystSymbol(
  db: DatabaseType,
  opts: {
    symbol: string;
    earningsDate: string;
    close: number;
    sma50?: number;
    rsi14?: number;
    atr14?: number;
    low52w: number;
    profitGrowthYoY?: number | null;
    withNews?: boolean;
    sentiment?: number | null;
  },
): void {
  const {
    symbol,
    earningsDate,
    close,
    sma50,
    rsi14 = 52,
    atr14 = 4,
    low52w,
    profitGrowthYoY = null,
    withNews = true,
    sentiment = 0.2,
  } = opts;

  db.prepare(
    `INSERT INTO earnings_calendar (symbol, expected_date, source) VALUES (?, ?, 'test')`,
  ).run(symbol, earningsDate);

  db.prepare(
    `
    INSERT INTO quotes (symbol, exchange, date, open, high, low, close, volume, source)
    VALUES
      (?, 'NSE', ?, ?, ?, ?, ?, 1000, 'test'),
      (?, 'NSE', date(?, '-300 days'), ?, ?, ?, ?, 1000, 'test')
  `,
  ).run(
    symbol,
    AS_OF,
    close,
    close + 2,
    low52w + 1,
    close,
    symbol,
    AS_OF,
    low52w + 2,
    low52w + 4,
    low52w,
    low52w + 3,
  );

  if (sma50 != null) {
    db.prepare(
      `INSERT INTO signals (symbol, date, name, value, source) VALUES (?, ?, 'sma_50', ?, 'technical')`,
    ).run(symbol, AS_OF, sma50);
  }
  db.prepare(
    `INSERT INTO signals (symbol, date, name, value, source) VALUES (?, ?, 'rsi_14', ?, 'technical')`,
  ).run(symbol, AS_OF, rsi14);
  db.prepare(
    `INSERT INTO signals (symbol, date, name, value, source) VALUES (?, ?, 'atr_14', ?, 'technical')`,
  ).run(symbol, AS_OF, atr14);

  db.prepare(
    `INSERT INTO fundamentals (symbol, as_of, profit_growth_yoy, source) VALUES (?, ?, ?, 'yahoo_snapshot')`,
  ).run(symbol, AS_OF, profitGrowthYoY);

  if (withNews) {
    db.prepare(
      `
      INSERT INTO news (symbol, headline, source, url, published_at, sentiment)
      VALUES (?, ?, 'test', ?, datetime(?, '-2 days'), ?)
    `,
    ).run(symbol, `${symbol} headline`, `https://example.com/${symbol}`, AS_OF, sentiment);
  }
}

function symbols(rows: Array<{ symbol: string }>): string[] {
  return rows.map((r) => r.symbol).sort();
}

describe('catalyst screener', () => {
  it('earnings day 4 out → not returned', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedCatalystSymbol(db, {
      symbol: 'DAY4',
      earningsDate: '2026-05-05',
      close: 110,
      sma50: 100,
      low52w: 90,
    });
    const rows = runCatalystScreener(db, AS_OF, new Set(), new Set());
    expect(symbols(rows)).toEqual([]);
  });

  it('earnings day 5 in → returned', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedCatalystSymbol(db, {
      symbol: 'DAY5',
      earningsDate: '2026-05-06',
      close: 110,
      sma50: 100,
      low52w: 90,
    });
    const rows = runCatalystScreener(db, AS_OF, new Set(), new Set());
    expect(symbols(rows)).toEqual(['DAY5']);
  });

  it('earnings day 14 in → returned', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedCatalystSymbol(db, {
      symbol: 'DAY14',
      earningsDate: '2026-05-15',
      close: 110,
      sma50: 100,
      low52w: 90,
    });
    const rows = runCatalystScreener(db, AS_OF, new Set(), new Set());
    expect(symbols(rows)).toEqual(['DAY14']);
  });

  it('earnings day 15 out → not returned', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedCatalystSymbol(db, {
      symbol: 'DAY15',
      earningsDate: '2026-05-16',
      close: 110,
      sma50: 100,
      low52w: 90,
    });
    const rows = runCatalystScreener(db, AS_OF, new Set(), new Set());
    expect(symbols(rows)).toEqual([]);
  });

  it('excludes ETF symbols post-query', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedCatalystSymbol(db, {
      symbol: 'ETFTEST',
      earningsDate: '2026-05-10',
      close: 110,
      sma50: 100,
      low52w: 90,
    });
    const rows = runCatalystScreener(db, AS_OF, new Set(), new Set(['ETFTEST']));
    expect(rows).toHaveLength(0);
  });

  it('excludes already-owned symbols post-query', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedCatalystSymbol(db, {
      symbol: 'OWNED1',
      earningsDate: '2026-05-10',
      close: 110,
      sma50: 100,
      low52w: 90,
    });
    const rows = runCatalystScreener(db, AS_OF, new Set(['OWNED1']), new Set());
    expect(rows).toHaveLength(0);
  });

  it('hard-excludes null sma_50 rows', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedCatalystSymbol(db, {
      symbol: 'NOSMA',
      earningsDate: '2026-05-10',
      close: 110,
      low52w: 90,
      sma50: undefined,
    });
    const rows = runCatalystScreener(db, AS_OF, new Set(), new Set());
    expect(rows).toHaveLength(0);
  });

  it('passes when news is missing (fail-open sentiment)', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedCatalystSymbol(db, {
      symbol: 'NONWS',
      earningsDate: '2026-05-10',
      close: 110,
      sma50: 100,
      low52w: 90,
      withNews: false,
    });
    const rows = runCatalystScreener(db, AS_OF, new Set(), new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recent_sentiment_avg).toBeNull();
  });

  it('excludes when price < sma_50 and pct_from_52w_low >= 15', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedCatalystSymbol(db, {
      symbol: 'GATEFAIL',
      earningsDate: '2026-05-10',
      close: 100,
      sma50: 110,
      low52w: 80,
    });
    const rows = runCatalystScreener(db, AS_OF, new Set(), new Set());
    expect(rows).toHaveLength(0);
  });

  it('includes when price < sma_50 but pct_from_52w_low < 15', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedCatalystSymbol(db, {
      symbol: 'GATEPASS',
      earningsDate: '2026-05-10',
      close: 100,
      sma50: 110,
      low52w: 95,
    });
    const rows = runCatalystScreener(db, AS_OF, new Set(), new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.symbol).toBe('GATEPASS');
  });

  it('inserts catalyst paper trade with stop_type=fixed', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.prepare(
      `
      INSERT INTO screens (symbol, date, screen_name, score, matched_criteria)
      VALUES ('CATFIX', ?, 'catalyst_entry', 1, ?)
    `,
    ).run(AS_OF, JSON.stringify({ days_to_earnings: 7, atr_14: 3.2 }));

    const theses: ThesisCard[] = [
      {
        symbol: 'CATFIX',
        thesis: 'Catalyst thesis.',
        bullCase: ['b1'],
        bearCase: ['r1'],
        entryZone: '₹100',
        stopLoss: '₹95',
        target: '₹110',
        timeHorizon: 'short',
        confidence: 6,
        triggerReason: 'catalyst_entry',
      },
    ];
    recordPaperTrades(AS_OF, theses, undefined, db);
    const row = db
      .prepare(`SELECT signal_type, stop_type FROM paper_trades WHERE symbol = 'CATFIX'`)
      .get() as { signal_type: string; stop_type: string } | undefined;
    expect(row?.signal_type).toBe('catalyst_entry');
    expect(row?.stop_type).toBe('fixed');
  });

  it('migration default keeps existing OPEN insert stop_type=trailing', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.prepare(
      `
      INSERT INTO paper_trades (
        symbol, signal_type, source_date, entry_price, stop_loss, target,
        time_horizon, max_hold_days, status
      ) VALUES ('LEGACY', 'AI_PICK', ?, 100, 90, 120, 'medium', 30, 'OPEN')
    `,
    ).run(AS_OF);
    const row = db.prepare(`SELECT stop_type FROM paper_trades WHERE symbol = 'LEGACY'`).get() as
      | { stop_type: string }
      | undefined;
    expect(row?.stop_type).toBe('trailing');
  });
});
