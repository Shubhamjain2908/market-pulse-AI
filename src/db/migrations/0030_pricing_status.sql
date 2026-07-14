-- Migration 0030: Pricing State for paper trades
-- Tracks whether an OPEN paper trade has an NSE quote for the expected session.
--
-- Uses a separate column rather than changing `status` to preserve
-- cross-strategy entry dedup (`hasOpenPaperTradeForSymbol` checks
-- `status = 'OPEN'`).

ALTER TABLE paper_trades ADD COLUMN pricing_status TEXT NOT NULL DEFAULT 'PRICED'
  CHECK (pricing_status IN ('PRICED', 'UNPRICED'));

ALTER TABLE paper_trades ADD COLUMN pricing_status_as_of TEXT;

ALTER TABLE paper_trades ADD COLUMN last_quote_date TEXT;
