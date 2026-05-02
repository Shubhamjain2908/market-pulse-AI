-- Phase 7: Paper trades ledger for forward-testing LLM signals (no real execution).

CREATE TABLE IF NOT EXISTS paper_trades (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol         TEXT    NOT NULL,
  signal_type    TEXT    NOT NULL,
  source_date    TEXT    NOT NULL,
  entry_price    REAL    NOT NULL,
  stop_loss      REAL    NOT NULL,
  target         REAL    NOT NULL,
  time_horizon   TEXT    NOT NULL,
  max_hold_days  INTEGER NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'OPEN',
  outcome_date   TEXT,
  exit_price     REAL,
  pnl_pct        REAL,
  notes          TEXT,
  created_at     TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_paper_trades_signal_day
  ON paper_trades(symbol, signal_type, source_date);

CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON paper_trades(status);
CREATE INDEX IF NOT EXISTS idx_paper_trades_outcome_date ON paper_trades(outcome_date);
