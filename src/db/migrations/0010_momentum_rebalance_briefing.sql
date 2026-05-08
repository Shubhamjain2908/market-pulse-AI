-- Last momentum rebalance facts for a calendar day (drives HTML when `brief` runs without --brief).
CREATE TABLE IF NOT EXISTS momentum_rebalance_briefing (
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
);
