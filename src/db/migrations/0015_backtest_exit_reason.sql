-- Add exit_reason to backtest_trades for post-run analysis
ALTER TABLE backtest_trades ADD COLUMN exit_reason TEXT;
