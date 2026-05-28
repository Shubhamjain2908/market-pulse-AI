import type { Database as DatabaseType } from 'better-sqlite3';
import { child } from '../logger.js';

const log = child({ component: 'catalyst-screener' });

export interface CatalystCandidate {
  symbol: string;
  expected_earnings_date: string;
  days_to_earnings: number;
  close: number;
  sma_50: number;
  rsi_14: number | null;
  atr_14: number | null;
  pct_from_sma50: number;
  pct_from_52w_low: number | null;
  recent_sentiment_avg: number | null;
  recent_news_count: number;
  profit_growth_yoy: number | null;
}

export function runCatalystScreener(
  db: DatabaseType,
  asOf: string,
  alreadyOwned: Set<string>,
  etfExclusions: Set<string>,
): CatalystCandidate[] {
  const rows = db
    .prepare(
      `
      WITH upcoming_earnings AS (
        SELECT
          symbol,
          expected_date,
          CAST(julianday(expected_date) - julianday(:today) AS INTEGER) AS days_to_earnings
        FROM earnings_calendar
        WHERE expected_date BETWEEN date(:today, '+5 days')
                                AND date(:today, '+14 days')
      ),
      latest_signals AS (
        SELECT
          symbol,
          MAX(CASE WHEN name = 'sma_50' THEN value END) AS sma_50,
          MAX(CASE WHEN name = 'rsi_14' THEN value END) AS rsi_14,
          MAX(CASE WHEN name = 'atr_14' THEN value END) AS atr_14
        FROM (
          SELECT
            symbol,
            name,
            value,
            ROW_NUMBER() OVER (PARTITION BY symbol, name ORDER BY date DESC) AS rn
          FROM signals
          WHERE date >= date(:today, '-90 days')
            AND date <= :today
            AND name IN ('sma_50', 'rsi_14', 'atr_14')
        )
        WHERE rn = 1
        GROUP BY symbol
      ),
      low_52w AS (
        SELECT
          symbol,
          MIN(low) AS low_52w
        FROM quotes
        WHERE exchange = 'NSE'
          AND date >= date(:today, '-365 days')
          AND date <= :today
        GROUP BY symbol
      ),
      recent_news AS (
        SELECT
          symbol,
          AVG(sentiment) AS avg_sentiment,
          COUNT(*) AS news_count
        FROM news
        WHERE published_at >= datetime(:today, '-7 days')
          AND symbol IS NOT NULL
        GROUP BY symbol
      ),
      latest_close AS (
        SELECT
          q.symbol,
          q.close
        FROM quotes q
        WHERE q.exchange = 'NSE'
          AND q.date = (
            SELECT MAX(date)
            FROM quotes q2
            WHERE q2.symbol = q.symbol
              AND q2.exchange = 'NSE'
              AND q2.date <= :today
          )
      ),
      latest_fundamentals AS (
        SELECT symbol, profit_growth_yoy
        FROM (
          SELECT
            symbol,
            profit_growth_yoy,
            ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY as_of DESC) AS rn
          FROM fundamentals
          WHERE as_of <= :today
        )
        WHERE rn = 1
      )
      SELECT
        ue.symbol AS symbol,
        ue.expected_date AS expected_earnings_date,
        ue.days_to_earnings AS days_to_earnings,
        lc.close AS close,
        ls.sma_50 AS sma_50,
        ls.rsi_14 AS rsi_14,
        ls.atr_14 AS atr_14,
        ((lc.close - ls.sma_50) / ls.sma_50) * 100.0 AS pct_from_sma50,
        CASE
          WHEN l52.low_52w IS NULL OR l52.low_52w = 0 THEN NULL
          ELSE ((lc.close - l52.low_52w) / l52.low_52w) * 100.0
        END AS pct_from_52w_low,
        rn.avg_sentiment AS recent_sentiment_avg,
        COALESCE(rn.news_count, 0) AS recent_news_count,
        lf.profit_growth_yoy AS profit_growth_yoy
      FROM upcoming_earnings ue
      JOIN latest_signals ls ON ls.symbol = ue.symbol
      JOIN latest_close lc ON lc.symbol = ue.symbol
      LEFT JOIN low_52w l52 ON l52.symbol = ue.symbol
      LEFT JOIN recent_news rn ON rn.symbol = ue.symbol
      LEFT JOIN latest_fundamentals lf ON lf.symbol = ue.symbol
      WHERE ls.sma_50 IS NOT NULL
        AND lc.close IS NOT NULL
        AND ue.expected_date IS NOT NULL
        AND (
          lc.close > ls.sma_50
          OR (
            CASE
              WHEN l52.low_52w IS NULL OR l52.low_52w = 0 THEN NULL
              ELSE ((lc.close - l52.low_52w) / l52.low_52w) * 100.0
            END
          ) < 15.0
        )
      ORDER BY ue.days_to_earnings ASC, ue.symbol ASC
    `,
    )
    .all({ today: asOf }) as CatalystCandidate[];

  const screened: CatalystCandidate[] = [];
  let excludedEtf = 0;
  let excludedOwned = 0;
  let hardNullSkipped = 0;

  for (const row of rows) {
    const symbol = row.symbol.toUpperCase();
    if (etfExclusions.has(symbol)) {
      excludedEtf++;
      continue;
    }
    if (alreadyOwned.has(symbol)) {
      excludedOwned++;
      continue;
    }
    if (row.close == null || row.sma_50 == null) {
      hardNullSkipped++;
      log.warn({ symbol }, 'catalyst row skipped due to hard-null close/sma_50');
      continue;
    }
    screened.push({ ...row, symbol });
  }

  log.debug(
    {
      asOf,
      totalRows: rows.length,
      excludedEtf,
      excludedOwned,
      hardNullSkipped,
      returned: screened.length,
    },
    'catalyst screener post-query filtering complete',
  );

  return screened;
}
