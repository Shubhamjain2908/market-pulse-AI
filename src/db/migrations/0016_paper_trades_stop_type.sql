ALTER TABLE paper_trades
  ADD COLUMN stop_type TEXT NOT NULL DEFAULT 'trailing';
