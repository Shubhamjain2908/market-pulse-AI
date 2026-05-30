-- Daily NSE iNAV vs last-price snapshots for held ETFs (briefing premium/discount alerts).

CREATE TABLE IF NOT EXISTS inav_snapshots (
  symbol                 TEXT NOT NULL,
  date                   TEXT NOT NULL,
  inav                   REAL NOT NULL,
  last_price             REAL NOT NULL,
  premium_discount_pct   REAL NOT NULL,
  captured_at            TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (symbol, date)
);

CREATE INDEX IF NOT EXISTS idx_inav_snapshots_date ON inav_snapshots(date);
