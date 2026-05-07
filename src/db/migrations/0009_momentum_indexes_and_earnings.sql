-- Momentum screener v1: paper_trade lookups + Yahoo earnings calendar (Phase 1 schema).

CREATE INDEX IF NOT EXISTS idx_paper_trades_signal_type ON paper_trades(signal_type);

CREATE INDEX IF NOT EXISTS idx_paper_trades_signal_status ON paper_trades(signal_type, status);

-- Next earnings date per Yahoo quoteSummary (first future date only; refreshed weekly).
CREATE TABLE IF NOT EXISTS earnings_calendar (
  symbol        TEXT NOT NULL,
  expected_date TEXT NOT NULL, -- YYYY-MM-DD
  source        TEXT NOT NULL,
  fetched_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol, expected_date)
);

CREATE INDEX IF NOT EXISTS idx_earnings_calendar_expected_date ON earnings_calendar(expected_date);
