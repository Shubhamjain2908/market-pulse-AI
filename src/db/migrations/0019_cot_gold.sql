-- COMEX gold COT (CFTC disaggregated futures) — weekly ingest for macro briefing line.

CREATE TABLE IF NOT EXISTS cot_gold (
  report_date       TEXT NOT NULL PRIMARY KEY,
  mm_long           INTEGER NOT NULL,
  mm_short          INTEGER NOT NULL,
  mm_net            INTEGER NOT NULL,
  open_interest     INTEGER NOT NULL,
  mm_net_oi_ratio   REAL NOT NULL,
  ingested_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
