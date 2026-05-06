-- Adaptive trailing stop (ATR-based) — additive columns + audit log.
-- Appendix-only migration; never edit prior files.

ALTER TABLE paper_trades ADD COLUMN highest_close_since_entry REAL;
ALTER TABLE paper_trades ADD COLUMN atr14_at_entry REAL;
ALTER TABLE paper_trades ADD COLUMN trailing_multiplier REAL DEFAULT 2.0;
ALTER TABLE paper_trades ADD COLUMN stop_raised_today INTEGER DEFAULT 0;
ALTER TABLE paper_trades ADD COLUMN exit_reason TEXT;
-- exit_reason ∈ TRAILING_STOP | INITIAL_STOP | TARGET_HIT | TIME_EXIT | MANUAL (application-enforced).

CREATE TABLE IF NOT EXISTS trailing_stop_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id        INTEGER NOT NULL REFERENCES paper_trades(id),
  symbol          TEXT    NOT NULL,
  log_date        TEXT    NOT NULL,
  prev_stop       REAL    NOT NULL,
  new_stop        REAL    NOT NULL,
  stop_delta      REAL    NOT NULL,
  candidate_stop  REAL    NOT NULL,
  highest_close   REAL    NOT NULL,
  atr14_today     REAL,
  multiplier_used REAL    NOT NULL,
  unrealised_pct  REAL    NOT NULL,
  action          TEXT    NOT NULL,
  narrative       TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trailing_log_date  ON trailing_stop_log(log_date);
CREATE INDEX IF NOT EXISTS idx_trailing_log_trade ON trailing_stop_log(trade_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_trailing_log_trade_day_action
  ON trailing_stop_log(trade_id, log_date, action);
