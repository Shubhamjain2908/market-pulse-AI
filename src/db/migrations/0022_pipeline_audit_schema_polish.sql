-- Pipeline audit table, backtest DD fix, schema polish.
-- Audit 2026-06-11. Append-only.

-- Stage-level audit trail for daily-workflow.ts pipeline runs.
-- Allows briefing composer to refuse rendering on partial pipelines.
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date    TEXT NOT NULL,
  stage       TEXT NOT NULL,
  status      TEXT NOT NULL
              CHECK (status IN ('started','success','failed','skipped')),
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  error_msg   TEXT,
  metadata    TEXT   -- JSON blob; optional per stage
);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_date_stage
  ON pipeline_runs(run_date, stage);

-- NOTE: column goes on backtest_runs (run-summary), NOT backtest_trades.
-- backtest_trades.max_drawdown_pct already exists as per-trade DD (0003:59).
-- The CHECK relies on SQLite's NULL <= 0 = NULL truth value — passes for NULL rows.

-- Equity-curve max drawdown on backtest_runs.
-- Existing max_drawdown_pct is per-trade worst; this is the
-- portfolio-level equity-curve DD computed in runner.ts (wired in
-- a later PR). CHECK enforces DD is non-positive.
ALTER TABLE backtest_runs
  ADD COLUMN equity_curve_max_dd_pct REAL
  CHECK (equity_curve_max_dd_pct IS NULL OR equity_curve_max_dd_pct <= 0);

-- Filtered view: excludes STALE_HOLDINGS placeholder rows
-- (model='none') from portfolio analysis aggregations.
CREATE VIEW IF NOT EXISTS portfolio_analysis_llm AS
  SELECT * FROM portfolio_analysis
  WHERE model != 'none';
