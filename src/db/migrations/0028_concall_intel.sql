-- Migration 0028: Concall Intelligence Engine
-- Creates tables for storing NSE concall transcripts and LLM analyses.
-- Part of Task B (devin parity review).

CREATE TABLE IF NOT EXISTS concall_transcripts (
  symbol        TEXT NOT NULL,
  announced_at  TEXT NOT NULL,             -- an_dt normalised to ISO
  attachment_url TEXT NOT NULL,            -- NSE archive PDF URL
  kind          TEXT NOT NULL DEFAULT 'transcript',  -- transcript | audio_link | invite
  text          TEXT,                      -- extracted PDF text (~100KB typical)
  char_count    INTEGER,
  fetched_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (symbol, attachment_url)
);

CREATE TABLE IF NOT EXISTS concall_intel (
  symbol           TEXT NOT NULL,
  announced_at     TEXT NOT NULL,           -- ISO date of the concal announcement
  quarter_label    TEXT,                     -- e.g. 'Q3FY26' inferred by LLM
  sentiment        TEXT CHECK (sentiment IN ('positive','cautiously_positive','neutral','cautious','negative')),
  credibility_stars INTEGER CHECK (credibility_stars BETWEEN 1 AND 5),
  guidance_json    TEXT NOT NULL,            -- array of {metric, value, horizon, verbatim}
  delivery_json    TEXT,                     -- promise-vs-delivery vs previous: [{prior_guidance, outcome}]
  deflections_json TEXT,                     -- questions management dodged
  summary          TEXT NOT NULL,            -- <=120 word investor summary
  model            TEXT NOT NULL,            -- LLM model used for analysis
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (symbol, announced_at)
);

CREATE INDEX IF NOT EXISTS idx_concall_intel_symbol ON concall_intel(symbol);
CREATE INDEX IF NOT EXISTS idx_concall_intel_announced_at ON concall_intel(announced_at);
