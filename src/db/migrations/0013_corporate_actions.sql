-- Corporate actions (splits / bonus-as-split from Yahoo splitHistory) for paper trade nominal adjustments.

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
