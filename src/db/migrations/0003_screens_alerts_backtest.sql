-- Phase 2: Screening engine + watchlist alerts + backtest harness.

-- -----------------------------------------------------------------------
-- 1. Watchlist alerts — threshold-based notifications per symbol per day
-- -----------------------------------------------------------------------
-- Rules fire when a signal crosses a configured threshold (RSI ≥ 70,
-- volume ≥ 2× avg, etc.). Promoted to a table so we can show "alert
-- history" in future briefings and audit which alerts the user has acted
-- on.
CREATE TABLE IF NOT EXISTS alerts (
  symbol      TEXT NOT NULL,
  date        TEXT NOT NULL,
  kind        TEXT NOT NULL, -- 'rsi_overbought' | 'rsi_oversold' | 'volume_spike' | 'near_52w_high' | 'near_52w_low'
  signal      TEXT NOT NULL, -- e.g. 'rsi_14'
  value       REAL NOT NULL,
  message     TEXT NOT NULL,
  acted_on    INTEGER NOT NULL DEFAULT 0, -- 0/1, future use
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol, date, kind)
);
CREATE INDEX IF NOT EXISTS idx_alerts_date  ON alerts(date);
CREATE INDEX IF NOT EXISTS idx_alerts_kind  ON alerts(kind);

-- -----------------------------------------------------------------------
-- 2. Backtest runs — one row per (screen, window, holdDays) execution
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backtest_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  screen_name     TEXT    NOT NULL,
  start_date      TEXT    NOT NULL,
  end_date        TEXT    NOT NULL,
  hold_days       INTEGER NOT NULL,
  symbols_count   INTEGER NOT NULL,
  total_trades    INTEGER NOT NULL,
  winning_trades  INTEGER NOT NULL,
  losing_trades   INTEGER NOT NULL,
  hit_rate        REAL    NOT NULL, -- 0..1
  avg_return_pct  REAL    NOT NULL,
  median_return_pct REAL  NOT NULL,
  max_return_pct  REAL    NOT NULL,
  min_return_pct  REAL    NOT NULL,
  max_drawdown_pct REAL   NOT NULL, -- worst trade DD across the run
  created_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_screen ON backtest_runs(screen_name, created_at DESC);

-- -----------------------------------------------------------------------
-- 3. Backtest trades — every individual entry/exit produced by a run
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backtest_trades (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER NOT NULL,
  symbol        TEXT    NOT NULL,
  entry_date    TEXT    NOT NULL,
  entry_price   REAL    NOT NULL,
  exit_date     TEXT    NOT NULL,
  exit_price    REAL    NOT NULL,
  return_pct    REAL    NOT NULL,
  max_drawdown_pct REAL NOT NULL, -- worst close during the hold, 0..-100
  hold_days     INTEGER NOT NULL,
  FOREIGN KEY (run_id) REFERENCES backtest_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_backtest_trades_run     ON backtest_trades(run_id);
CREATE INDEX IF NOT EXISTS idx_backtest_trades_symbol  ON backtest_trades(symbol);
