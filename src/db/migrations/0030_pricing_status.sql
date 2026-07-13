-- Migration 0030: Pricing State for paper trades
-- Tracks whether a paper trade was successfully evaluated (priced),
-- has no data available (unpriced), or is missing recent bars (stale).
--
-- Uses a separate column rather than changing `status` to preserve
-- cross-strategy entry dedup (`hasOpenPaperTradeForSymbol` checks
-- `status = 'OPEN'`).

ALTER TABLE paper_trades ADD COLUMN pricing_status TEXT NOT NULL DEFAULT 'unpriced'
  CHECK (pricing_status IN ('priced', 'unpriced', 'stale'));
