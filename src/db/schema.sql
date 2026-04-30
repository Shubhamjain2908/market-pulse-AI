-- Market Pulse AI - SQLite schema
-- All ingested + derived data lives here. Migrations are append-only:
-- add new files in src/db/migrations/, never edit existing ones.

-- -----------------------------------------------------------------------
-- 1. Quotes (OHLCV) - written by quote ingestors (NSE, Yahoo, Kite ...)
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quotes (
  symbol      TEXT    NOT NULL,
  exchange    TEXT    NOT NULL DEFAULT 'NSE',
  date        TEXT    NOT NULL, -- YYYY-MM-DD (IST trading day)
  open        REAL    NOT NULL,
  high        REAL    NOT NULL,
  low         REAL    NOT NULL,
  close       REAL    NOT NULL,
  adj_close   REAL,
  volume      INTEGER NOT NULL,
  source      TEXT    NOT NULL,
  ingested_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol, exchange, date)
);
CREATE INDEX IF NOT EXISTS idx_quotes_date    ON quotes(date);
CREATE INDEX IF NOT EXISTS idx_quotes_symbol  ON quotes(symbol);

-- -----------------------------------------------------------------------
-- 2. Fundamentals - written by Screener.in (and similar) ingestors
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fundamentals (
  symbol                       TEXT NOT NULL,
  as_of                        TEXT NOT NULL, -- YYYY-MM-DD
  market_cap                   REAL,
  pe                           REAL,
  pb                           REAL,
  peg                          REAL,
  roe                          REAL,
  roce                         REAL,
  revenue_growth_yoy           REAL,
  profit_growth_yoy            REAL,
  debt_to_equity               REAL,
  promoter_holding_pct         REAL,
  promoter_holding_change_qoq  REAL,
  dividend_yield               REAL,
  source                       TEXT NOT NULL,
  ingested_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol, as_of)
);
CREATE INDEX IF NOT EXISTS idx_fundamentals_symbol ON fundamentals(symbol);

-- -----------------------------------------------------------------------
-- 3. News - written by RSS / NewsAPI ingestors
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS news (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol       TEXT,
  headline     TEXT NOT NULL,
  summary      TEXT,
  source       TEXT NOT NULL,
  url          TEXT NOT NULL,
  published_at TEXT NOT NULL,
  sentiment    REAL,
  ingested_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(url)
);
CREATE INDEX IF NOT EXISTS idx_news_symbol     ON news(symbol);
CREATE INDEX IF NOT EXISTS idx_news_published  ON news(published_at);

-- -----------------------------------------------------------------------
-- 4. FII/DII activity - written by NSE ingestor
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fii_dii (
  date        TEXT NOT NULL,
  segment     TEXT NOT NULL, -- 'cash' | 'fno' | 'fno_index_fut' | 'fno_stock_fut'
  fii_buy     REAL NOT NULL,
  fii_sell    REAL NOT NULL,
  fii_net     REAL NOT NULL,
  dii_buy     REAL NOT NULL,
  dii_sell    REAL NOT NULL,
  dii_net     REAL NOT NULL,
  source      TEXT NOT NULL,
  ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (date, segment)
);

-- -----------------------------------------------------------------------
-- 5. Signals - written by the Enricher
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signals (
  symbol     TEXT NOT NULL,
  date       TEXT NOT NULL,
  name       TEXT NOT NULL, -- e.g. 'sma_20', 'rsi_14', 'volume_ratio_20d'
  value      REAL NOT NULL,
  source     TEXT NOT NULL, -- 'technical' | 'fundamental' | 'sentiment' | 'flow'
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol, date, name)
);
CREATE INDEX IF NOT EXISTS idx_signals_date_name ON signals(date, name);
CREATE INDEX IF NOT EXISTS idx_signals_symbol    ON signals(symbol);

-- -----------------------------------------------------------------------
-- 6. Screen results - written by the Analyser
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS screens (
  symbol            TEXT NOT NULL,
  date              TEXT NOT NULL,
  screen_name       TEXT NOT NULL,
  score             REAL NOT NULL,
  matched_criteria  TEXT NOT NULL, -- JSON
  thesis_json       TEXT,          -- JSON, populated after AI pass
  computed_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol, date, screen_name)
);
CREATE INDEX IF NOT EXISTS idx_screens_date_screen ON screens(date, screen_name);

-- -----------------------------------------------------------------------
-- 7. Portfolio - manual entries in Phase 1-4, Kite-synced in Phase 5
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portfolio (
  symbol     TEXT    NOT NULL,
  qty        REAL    NOT NULL,
  avg_price  REAL    NOT NULL,
  stop_loss  REAL,
  target     REAL,
  notes      TEXT,
  updated_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol)
);

-- -----------------------------------------------------------------------
-- 8. Briefings - audit trail of generated briefings
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS briefings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL,
  html_content    TEXT NOT NULL,
  delivery_method TEXT NOT NULL, -- 'file' | 'email' | 'slack' | 'telegram'
  delivered_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_briefings_date ON briefings(date);

-- -----------------------------------------------------------------------
-- 9. Symbol universe - master list, populated from NSE 500 + watchlist
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS symbols (
  symbol      TEXT PRIMARY KEY,
  name        TEXT,
  exchange    TEXT NOT NULL DEFAULT 'NSE',
  sector      TEXT,
  industry    TEXT,
  is_index    INTEGER NOT NULL DEFAULT 0, -- 0/1
  is_active   INTEGER NOT NULL DEFAULT 1, -- 0/1
  added_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
