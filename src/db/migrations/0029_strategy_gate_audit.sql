-- Migration 0029: Strategy Gate Audit Trail (Task D)
-- Records every gate decision so we can answer WHY a strategy/screen
-- was allowed, blocked, or skipped on a given date.
--
-- One row per (date, strategy_id, gate_name) per pipeline run.
-- gate_name distinguishes which gate point: 'regime' (regime_strategy_gate),
-- 'sector_cap', 'blackout', 'false_flag', 'cross_strategy', etc.

CREATE TABLE IF NOT EXISTS strategy_gate_audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT    NOT NULL,               -- pipeline run date (YYYY-MM-DD)
  strategy_id     TEXT    NOT NULL,               -- e.g. 'quality_garp', 'momentum_mf'
  gate_name       TEXT    NOT NULL,               -- e.g. 'regime', 'sector_cap', 'blackout'
  allowed         INTEGER NOT NULL DEFAULT 0,     -- 1 = passed gate, 0 = blocked
  regime          TEXT,                           -- current regime when gate was evaluated
  size_multiplier REAL    NOT NULL DEFAULT 1.0,   -- active size multiplier at decision time
  reason          TEXT    NOT NULL,               -- human-readable why decision was made
  symbol          TEXT,                           -- optional: symbol context when gate is per-symbol
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gate_audit_date    ON strategy_gate_audit(date);
CREATE INDEX IF NOT EXISTS idx_gate_audit_strategy ON strategy_gate_audit(strategy_id);
CREATE INDEX IF NOT EXISTS idx_gate_audit_symbol   ON strategy_gate_audit(symbol);
