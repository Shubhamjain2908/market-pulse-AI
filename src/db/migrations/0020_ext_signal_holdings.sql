CREATE TABLE ext_signal_holdings (
  strategy_name  TEXT NOT NULL,
  symbol         TEXT NOT NULL,
  as_of          TEXT NOT NULL,
  weight_pct     REAL NOT NULL,
  price          REAL,
  source         TEXT NOT NULL DEFAULT 'ext_signal',
  ingested_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (strategy_name, symbol, as_of)
);
CREATE INDEX idx_ext_signal_holdings_symbol_date
  ON ext_signal_holdings(symbol, as_of);
