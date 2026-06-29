-- Quarterly fundamentals from Screener.in #quarters & #cash-flow tables
-- Stores quarterly (revenue, OPM, EPS) and annual cash flow data per symbol.
-- Each row represents either a fiscal quarter or fiscal year end.
-- Cash flow fields are populated at fiscal year end (Dec) rows only.

CREATE TABLE IF NOT EXISTS quarterly_fundamentals (
  symbol                TEXT NOT NULL,
  quarter_end           TEXT NOT NULL,         -- YYYY-MM-DD (quarter or fiscal-year end)
  revenue               REAL,                  -- ₹ crores (quarterly)
  operating_profit      REAL,                  -- ₹ crores (quarterly)
  opm_pct               REAL,                  -- % (quarterly)
  net_profit            REAL,                  -- ₹ crores (quarterly)
  eps                   REAL,                  -- ₹ per share (quarterly)
  operating_cash_flow   REAL,                  -- ₹ crores (annual, from cash-flow table)
  free_cash_flow        REAL,                  -- ₹ crores (annual, from cash-flow table)
  source                TEXT NOT NULL,
  ingested_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol, quarter_end)
);

CREATE INDEX IF NOT EXISTS idx_qfund_symbol    ON quarterly_fundamentals(symbol);
CREATE INDEX IF NOT EXISTS idx_qfund_quarter   ON quarterly_fundamentals(quarter_end);
