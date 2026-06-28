CREATE TABLE _migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
CREATE TABLE quotes (
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
CREATE INDEX idx_quotes_date    ON quotes(date);
CREATE INDEX idx_quotes_symbol  ON quotes(symbol);
CREATE TABLE fundamentals (
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
  net_profit_ttm               REAL,
  debt_to_equity               REAL,
  promoter_holding_pct         REAL,
  promoter_holding_change_qoq  REAL,
  dividend_yield               REAL,
  source                       TEXT NOT NULL,
  ingested_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol, as_of)
);
CREATE INDEX idx_fundamentals_symbol ON fundamentals(symbol);
CREATE INDEX idx_fundamentals_asof ON fundamentals(as_of);
CREATE INDEX idx_fundamentals_source_symbol_asof ON fundamentals(source, symbol, as_of DESC);
CREATE TABLE news (
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
CREATE TABLE sqlite_sequence(name,seq);
CREATE INDEX idx_news_symbol     ON news(symbol);
CREATE INDEX idx_news_published  ON news(published_at);
CREATE INDEX idx_news_symbol_published ON news(symbol, published_at DESC);
CREATE TABLE fii_dii (
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
CREATE TABLE inav_snapshots (
  symbol                 TEXT NOT NULL,
  date                   TEXT NOT NULL,
  inav                   REAL NOT NULL,
  last_price             REAL NOT NULL,
  premium_discount_pct   REAL NOT NULL,
  captured_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol, date)
);
CREATE INDEX idx_inav_snapshots_date ON inav_snapshots(date);
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
CREATE INDEX idx_ext_signal_holdings_symbol_date ON ext_signal_holdings(symbol, as_of);
CREATE TABLE cot_gold (
  report_date       TEXT NOT NULL PRIMARY KEY,
  mm_long           INTEGER NOT NULL,
  mm_short          INTEGER NOT NULL,
  mm_net            INTEGER NOT NULL,
  open_interest     INTEGER NOT NULL,
  mm_net_oi_ratio   REAL NOT NULL,
  ingested_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE signals (
  symbol     TEXT NOT NULL,
  date       TEXT NOT NULL,
  name       TEXT NOT NULL, -- e.g. 'sma_20', 'rsi_14', 'volume_ratio_20d', 'weinstein_stage_code'
  value      REAL NOT NULL,
  source     TEXT NOT NULL, -- 'technical' | 'fundamental' | 'sentiment' | 'flow'
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol, date, name)
);
CREATE INDEX idx_signals_date_name ON signals(date, name);
CREATE INDEX idx_signals_symbol    ON signals(symbol);
-- Hot-path covering index for getLatestSignalsMap* (migration 0021); preferred for symbol+name+date DESC lookups.
CREATE INDEX idx_signals_symbol_name_date ON signals(symbol, name, date DESC);
CREATE TABLE screens (
  symbol            TEXT NOT NULL,
  date              TEXT NOT NULL,
  screen_name       TEXT NOT NULL,
  score             REAL NOT NULL,
  matched_criteria  TEXT NOT NULL, -- JSON
  thesis_json       TEXT,          -- JSON, populated after AI pass
  computed_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol, date, screen_name)
);
CREATE INDEX idx_screens_date_screen ON screens(date, screen_name);
-- Custom screen dispatchers store rich JSON in screens.matched_criteria (not DSL criteria arrays):
-- quality_garp: latest/prev/third ROE, latest ROCE, pe/pb/peg, debt_to_equity, promoter fields, rsi/sma50/close, optional __regime_meta
-- catalyst_entry: earnings date, days_to_earnings, atr_14, news/sentiment fields, optional __regime_meta
CREATE TABLE portfolio (
  symbol     TEXT    NOT NULL,
  qty        REAL    NOT NULL,
  avg_price  REAL    NOT NULL,
  stop_loss  REAL,
  target     REAL,
  notes      TEXT,
  updated_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol)
);
CREATE TABLE briefings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL,
  html_content    TEXT NOT NULL,
  delivery_method TEXT NOT NULL, -- 'file' | 'email'
  delivered_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_briefings_date ON briefings(date);
-- Per-stage audit trail for daily-workflow.ts (migration 0022). status: started | success | failed | skipped.
-- Append-only: retries insert new rows; getPipelineHealth uses latest id per (run_date, stage).
CREATE TABLE pipeline_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date    TEXT NOT NULL,
  stage       TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('started','success','failed','skipped')),
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  error_msg   TEXT,
  metadata    TEXT
);
CREATE INDEX idx_pipeline_runs_date_stage ON pipeline_runs(run_date, stage);
CREATE TABLE symbols (
  symbol      TEXT PRIMARY KEY,
  name        TEXT,
  exchange    TEXT NOT NULL DEFAULT 'NSE',
  sector      TEXT,
  industry    TEXT,
  is_index    INTEGER NOT NULL DEFAULT 0, -- 0/1
  is_active   INTEGER NOT NULL DEFAULT 1, -- 0/1
  added_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE theses (
  symbol          TEXT    NOT NULL,
  date            TEXT    NOT NULL,
  thesis          TEXT    NOT NULL,
  bull_case       TEXT    NOT NULL, -- JSON array of strings
  bear_case       TEXT    NOT NULL, -- JSON array of strings
  entry_zone      TEXT    NOT NULL,
  stop_loss       TEXT    NOT NULL,
  target          TEXT    NOT NULL,
  time_horizon    TEXT    NOT NULL CHECK (time_horizon IN ('short', 'medium', 'long')),
  confidence      INTEGER NOT NULL CHECK (confidence BETWEEN 1 AND 10),
  trigger_reason  TEXT    NOT NULL, -- what screen/signal triggered this
  model           TEXT    NOT NULL, -- which LLM model generated it
  raw_response    TEXT,             -- full LLM response for audit
  created_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol, date)
);
CREATE INDEX idx_theses_date ON theses(date);
CREATE INDEX idx_news_sentiment ON news(sentiment);
CREATE TABLE alerts (
  symbol      TEXT NOT NULL,
  date        TEXT NOT NULL,
  kind        TEXT NOT NULL, -- 'rsi_overbought' | 'rsi_oversold' | 'volume_spike' | 'near_52w_high' | 'near_52w_low'
  signal      TEXT NOT NULL, -- e.g. 'rsi_14'
  value       REAL NOT NULL,
  message     TEXT NOT NULL,
  acted_on    INTEGER NOT NULL DEFAULT 0, -- 0/1, future use
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol, date, kind)
);
CREATE INDEX idx_alerts_date  ON alerts(date);
CREATE INDEX idx_alerts_kind  ON alerts(kind);
CREATE TABLE backtest_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  screen_name     TEXT    NOT NULL,
  start_date      TEXT    NOT NULL,
  end_date        TEXT    NOT NULL,
  hold_days       INTEGER NOT NULL,
  symbols_count   INTEGER NOT NULL,
  total_trades    INTEGER NOT NULL,
  winning_trades  INTEGER NOT NULL,
  losing_trades   INTEGER NOT NULL,
  hit_rate        REAL    NOT NULL, -- 0..1
  avg_return_pct  REAL    NOT NULL,
  median_return_pct REAL  NOT NULL,
  max_return_pct  REAL    NOT NULL,
  min_return_pct  REAL    NOT NULL,
  max_drawdown_pct REAL   NOT NULL, -- worst per-trade DD across the run (backtest_trades also has per-leg max_drawdown_pct)
  created_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
, strategy_id TEXT, expectancy REAL, avg_hold_days REAL, profit_factor REAL, universe_json TEXT, cost_bps_round_trip INTEGER, notes TEXT, equity_curve_max_dd_pct REAL CHECK (equity_curve_max_dd_pct IS NULL OR equity_curve_max_dd_pct <= 0));
-- equity_curve_max_dd_pct: portfolio-level equity-curve DD on the run summary (migration 0022); runner write pending.
CREATE INDEX idx_backtest_runs_screen ON backtest_runs(screen_name, created_at DESC);
CREATE TABLE backtest_trades (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER NOT NULL,
  symbol        TEXT    NOT NULL,
  entry_date    TEXT    NOT NULL,
  entry_price   REAL    NOT NULL,
  exit_date     TEXT    NOT NULL,
  exit_price    REAL    NOT NULL,
  return_pct    REAL    NOT NULL,
  max_drawdown_pct REAL NOT NULL, -- worst close during the hold, 0..-100
  hold_days     INTEGER NOT NULL, exit_reason TEXT,
  FOREIGN KEY (run_id) REFERENCES backtest_runs(id) ON DELETE CASCADE
);
CREATE INDEX idx_backtest_trades_run     ON backtest_trades(run_id);
CREATE INDEX idx_backtest_trades_symbol  ON backtest_trades(symbol);
CREATE TABLE kite_instruments (
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
CREATE INDEX idx_kite_instruments_token ON kite_instruments(instrument_token);
CREATE TABLE portfolio_holdings (
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
CREATE INDEX idx_portfolio_holdings_as_of ON portfolio_holdings(as_of DESC);
CREATE TABLE portfolio_analysis (
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
CREATE INDEX idx_portfolio_analysis_action ON portfolio_analysis(date, action);
-- Excludes non-LLM placeholders (model='none'): STALE_HOLDINGS + ALLOCATION_INSTRUMENT rows (migration 0022).
CREATE VIEW portfolio_analysis_llm AS
  SELECT * FROM portfolio_analysis
  WHERE model != 'none';
CREATE TABLE intraday_quotes (
  symbol       TEXT    NOT NULL,
  captured_at  TEXT    NOT NULL,    -- ISO 8601 UTC
  last_price   REAL    NOT NULL,
  prev_close   REAL,
  change_pct   REAL,
  volume       INTEGER,
  source       TEXT    NOT NULL,    -- 'kite-ltp' | 'kite-quote'
  PRIMARY KEY (symbol, captured_at)
);
CREATE INDEX idx_intraday_symbol_time ON intraday_quotes(symbol, captured_at DESC);
CREATE TABLE paper_trades (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol         TEXT    NOT NULL,
  signal_type    TEXT    NOT NULL,
  source_date    TEXT    NOT NULL,
  entry_price    REAL    NOT NULL,
  stop_loss      REAL    NOT NULL,
  target         REAL    NOT NULL,
  time_horizon   TEXT    NOT NULL,
  max_hold_days  INTEGER NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'OPEN',
  outcome_date   TEXT,
  exit_price     REAL,
  pnl_pct        REAL,
  notes          TEXT,
  created_at     TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
, highest_close_since_entry REAL, atr14_at_entry REAL, trailing_multiplier REAL DEFAULT 2.0, stop_raised_today INTEGER DEFAULT 0, exit_reason TEXT, stop_type TEXT NOT NULL DEFAULT 'trailing');
CREATE UNIQUE INDEX uq_paper_trades_signal_day
  ON paper_trades(symbol, signal_type, source_date);
-- Partial index for OPEN-trade hot path (migration 0021 replaces idx_paper_trades_status).
CREATE INDEX idx_pt_open ON paper_trades(symbol) WHERE status = 'OPEN';
CREATE INDEX idx_paper_trades_outcome_date ON paper_trades(outcome_date);
CREATE TABLE regime_daily (
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
CREATE INDEX idx_regime_daily_date ON regime_daily(date);
CREATE TABLE regime_strategy_gate (
  strategy_id       TEXT NOT NULL,
  regime            TEXT NOT NULL,
  allowed           INTEGER NOT NULL DEFAULT 1,
  size_multiplier   REAL NOT NULL DEFAULT 1.0,
  notes             TEXT,
  PRIMARY KEY (strategy_id, regime)
);
CREATE INDEX idx_regime_strategy_gate_regime ON regime_strategy_gate(regime);
-- `quality_garp` regime rows are seeded from config/strategy-gates.json.
-- isStrategyAllowed: missing (strategy_id, regime) row → DISALLOWED (fail-closed).
-- operating_margin_pct migration remains deferred (no schema delta in quality_garp v2).
CREATE TABLE trailing_stop_log (
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
, notes TEXT);
CREATE INDEX idx_trailing_log_date  ON trailing_stop_log(log_date);
CREATE INDEX idx_trailing_log_trade ON trailing_stop_log(trade_id);
CREATE UNIQUE INDEX uq_trailing_log_trade_day_action
  ON trailing_stop_log(trade_id, log_date, action);
CREATE INDEX idx_paper_trades_signal_type ON paper_trades(signal_type);
CREATE INDEX idx_paper_trades_signal_status ON paper_trades(signal_type, status);
CREATE TABLE earnings_calendar (
  symbol        TEXT NOT NULL,
  expected_date TEXT NOT NULL, -- YYYY-MM-DD
  source        TEXT NOT NULL,
  fetched_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol, expected_date)
);
CREATE INDEX idx_earnings_calendar_expected_date ON earnings_calendar(expected_date);
-- replaceMomentumEarningsCalendarForSymbol(db, symbol, rows): empty rows[] retains
-- existing symbol rows (Yahoo outage must not DELETE blackout dates).
CREATE TABLE momentum_rebalance_briefing (
  calendar_date      TEXT    PRIMARY KEY,
  session_date       TEXT    NOT NULL,
  regime_allowed     INTEGER NOT NULL,
  regime             TEXT,
  closed_rank_decay  INTEGER NOT NULL,
  entries_inserted   INTEGER NOT NULL,
  unchanged_held     INTEGER NOT NULL,
  sector_cap_blocked INTEGER NOT NULL,
  blackout_blocked   INTEGER NOT NULL,
  skipped_reason     TEXT,
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
, thesis_failed INTEGER, ranker_universe_size INTEGER, ranker_eligible_count INTEGER);
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE corporate_actions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol      TEXT    NOT NULL,
  ex_date     TEXT    NOT NULL,
  type        TEXT    NOT NULL,  -- 'split' | 'bonus'
  factor      REAL    NOT NULL,  -- adjustment divisor (e.g., 3.0 for a 3:1 split)
  source      TEXT    NOT NULL,  -- 'yahoo'
  applied_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(symbol, ex_date, type)
);
