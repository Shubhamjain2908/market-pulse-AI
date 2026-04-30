-- Phase 3: Standalone theses table for AI-generated investment theses.
-- Independent of screens — works for any stock on the watchlist.

CREATE TABLE IF NOT EXISTS theses (
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
CREATE INDEX IF NOT EXISTS idx_theses_date ON theses(date);

-- Sentiment index to support the enricher's WHERE sentiment IS NULL query
CREATE INDEX IF NOT EXISTS idx_news_sentiment ON news(sentiment);
