CREATE TABLE IF NOT EXISTS promoter_pledge (
  symbol               TEXT NOT NULL,
  shp_date             TEXT NOT NULL,
  pct_shares_pledged   REAL,
  pct_promoter_holding REAL,
  num_shares_pledged   REAL,
  source               TEXT NOT NULL DEFAULT 'nse',
  ingested_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol, shp_date)
);

CREATE INDEX IF NOT EXISTS idx_promoter_pledge_symbol ON promoter_pledge(symbol);
