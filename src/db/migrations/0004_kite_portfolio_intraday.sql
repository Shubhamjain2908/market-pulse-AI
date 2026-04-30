-- Phase 5: Kite portfolio sync + intraday refresh + per-holding analysis.

-- -----------------------------------------------------------------------
-- 1. Kite instrument map — symbol -> instrument_token, exchange, segment
-- -----------------------------------------------------------------------
-- Kite's quote/historical APIs key off instrument_token (an integer
-- assigned by Zerodha), not symbol. We sync the daily CSV dump from
-- https://api.kite.trade/instruments and lookup tokens locally.
CREATE TABLE IF NOT EXISTS kite_instruments (
  instrument_token INTEGER NOT NULL,
  exchange_token   INTEGER NOT NULL,
  tradingsymbol    TEXT    NOT NULL,
  name             TEXT,
  exchange         TEXT    NOT NULL,
  segment          TEXT,
  instrument_type  TEXT,
  expiry           TEXT,
  strike           REAL,
  tick_size        REAL,
  lot_size         INTEGER,
  last_price       REAL,
  updated_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (exchange, tradingsymbol)
);
CREATE INDEX IF NOT EXISTS idx_kite_instruments_token ON kite_instruments(instrument_token);

-- -----------------------------------------------------------------------
-- 2. Portfolio holdings — synced from Kite (or manual portfolio.json)
-- -----------------------------------------------------------------------
-- Snapshot per (symbol, as_of). We keep history so the briefing can show
-- "you bought 50 more INFY this week" and the portfolio analyser can
-- track changes in conviction over time.
CREATE TABLE IF NOT EXISTS portfolio_holdings (
  symbol           TEXT    NOT NULL,
  exchange         TEXT    NOT NULL DEFAULT 'NSE',
  as_of            TEXT    NOT NULL, -- YYYY-MM-DD
  qty              REAL    NOT NULL,
  avg_price        REAL    NOT NULL,
  last_price       REAL,             -- most recent close at sync time
  pnl              REAL,             -- (last_price - avg_price) * qty
  pnl_pct          REAL,             -- ((last_price / avg_price) - 1) * 100
  day_change       REAL,             -- (last_price - prev_close) * qty (Kite only)
  day_change_pct   REAL,
  product          TEXT,             -- 'CNC' | 'MIS' | etc (Kite only)
  source           TEXT NOT NULL,    -- 'kite' | 'manual'
  raw              TEXT,             -- JSON blob from broker, for debugging
  PRIMARY KEY (symbol, as_of)
);
CREATE INDEX IF NOT EXISTS idx_portfolio_holdings_as_of ON portfolio_holdings(as_of DESC);

-- -----------------------------------------------------------------------
-- 3. Portfolio analysis — LLM-generated per-holding action recommendation
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portfolio_analysis (
  symbol         TEXT NOT NULL,
  date           TEXT NOT NULL,      -- briefing date this analysis is for
  action         TEXT NOT NULL,      -- 'HOLD' | 'ADD' | 'TRIM' | 'EXIT'
  conviction     REAL NOT NULL,      -- 0..1, model's confidence
  thesis         TEXT NOT NULL,      -- 2-3 sentence narrative
  bull_points    TEXT NOT NULL,      -- JSON array of strings
  bear_points    TEXT NOT NULL,      -- JSON array of strings
  trigger_reason TEXT NOT NULL,      -- what changed since last review
  suggested_stop REAL,
  suggested_target REAL,
  pnl_pct        REAL,
  model          TEXT NOT NULL,
  raw_response   TEXT,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_portfolio_analysis_action ON portfolio_analysis(date, action);

-- -----------------------------------------------------------------------
-- 4. Intraday LTP cache — populated by `mp scan` (Phase 5)
-- -----------------------------------------------------------------------
-- Polled every N minutes during market hours. Lets the briefing show
-- "live" prices for portfolio holdings + watchlist alerts even when
-- run mid-session. One row per (symbol, captured_at) — small fact
-- table, prune older than 7 days separately.
CREATE TABLE IF NOT EXISTS intraday_quotes (
  symbol       TEXT    NOT NULL,
  captured_at  TEXT    NOT NULL,    -- ISO 8601 UTC
  last_price   REAL    NOT NULL,
  prev_close   REAL,
  change_pct   REAL,
  volume       INTEGER,
  source       TEXT    NOT NULL,    -- 'kite-ltp' | 'kite-quote'
  PRIMARY KEY (symbol, captured_at)
);
CREATE INDEX IF NOT EXISTS idx_intraday_symbol_time ON intraday_quotes(symbol, captured_at DESC);
