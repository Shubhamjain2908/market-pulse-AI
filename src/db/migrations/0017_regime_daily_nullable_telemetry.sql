-- Allow NULL on regime telemetry columns when inputs were missing at persist time.
-- Replaces NOT NULL from 0006 (0.0 was used as a corrupt sentinel).

PRAGMA foreign_keys=OFF;

CREATE TABLE regime_daily__0017 (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  date             TEXT    NOT NULL UNIQUE,
  regime           TEXT    NOT NULL,
  score_total      REAL    NOT NULL,
  score_trend      REAL    NOT NULL,
  score_vix        REAL    NOT NULL,
  score_fii        REAL    NOT NULL,
  score_breadth    REAL    NOT NULL,
  vix_value        REAL,
  nifty_vs_sma200  REAL,
  fii_20d_net      REAL,
  ad_ratio         REAL,
  pct_above_sma200 REAL,
  crisis_override  INTEGER NOT NULL DEFAULT 0,
  narrative        TEXT,
  prev_regime      TEXT,
  regime_age       INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO regime_daily__0017 (
  id, date, regime, score_total, score_trend, score_vix, score_fii, score_breadth,
  vix_value, nifty_vs_sma200, fii_20d_net, ad_ratio, pct_above_sma200,
  crisis_override, narrative, prev_regime, regime_age, created_at
)
SELECT
  id, date, regime, score_total, score_trend, score_vix, score_fii, score_breadth,
  vix_value, nifty_vs_sma200, fii_20d_net, ad_ratio, pct_above_sma200,
  crisis_override, narrative, prev_regime, regime_age, created_at
FROM regime_daily;

DROP TABLE regime_daily;

ALTER TABLE regime_daily__0017 RENAME TO regime_daily;

CREATE INDEX IF NOT EXISTS idx_regime_daily_date ON regime_daily(date);

PRAGMA foreign_keys=ON;
