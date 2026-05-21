-- Option A walk-forward backtest: extend run summary for strategy_id + extra metrics.

ALTER TABLE backtest_runs ADD COLUMN strategy_id TEXT;
ALTER TABLE backtest_runs ADD COLUMN expectancy REAL;
ALTER TABLE backtest_runs ADD COLUMN avg_hold_days REAL;
ALTER TABLE backtest_runs ADD COLUMN profit_factor REAL;
ALTER TABLE backtest_runs ADD COLUMN universe_json TEXT;
ALTER TABLE backtest_runs ADD COLUMN cost_bps_round_trip INTEGER;
ALTER TABLE backtest_runs ADD COLUMN notes TEXT;
