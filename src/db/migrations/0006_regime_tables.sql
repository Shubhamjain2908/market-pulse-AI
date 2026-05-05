-- Market regime meta-layer: daily classification + per-strategy gates.
-- Append-only migration — do not edit once applied.

CREATE TABLE IF NOT EXISTS regime_daily (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  date             TEXT    NOT NULL UNIQUE,
  regime           TEXT    NOT NULL,
  score_total      REAL    NOT NULL,
  score_trend      REAL    NOT NULL,
  score_vix        REAL    NOT NULL,
  score_fii        REAL    NOT NULL,
  score_breadth    REAL    NOT NULL,
  vix_value        REAL    NOT NULL,
  nifty_vs_sma200  REAL    NOT NULL,
  fii_20d_net      REAL    NOT NULL,
  ad_ratio         REAL,
  pct_above_sma200 REAL,
  crisis_override  INTEGER NOT NULL DEFAULT 0,
  narrative        TEXT,
  prev_regime      TEXT,
  regime_age       INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_regime_daily_date ON regime_daily(date);

CREATE TABLE IF NOT EXISTS regime_strategy_gate (
  strategy_id       TEXT NOT NULL,
  regime            TEXT NOT NULL,
  allowed           INTEGER NOT NULL DEFAULT 1,
  size_multiplier   REAL NOT NULL DEFAULT 1.0,
  notes             TEXT,
  PRIMARY KEY (strategy_id, regime)
);

CREATE INDEX IF NOT EXISTS idx_regime_strategy_gate_regime ON regime_strategy_gate(regime);
