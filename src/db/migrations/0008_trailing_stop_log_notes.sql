-- R3: queryable gap-through-stop flag for backtests (no boolean column).
-- Application sets notes = 'gap_down_open:true' on STOPPED_OUT when bar.open < active stop.

ALTER TABLE trailing_stop_log ADD COLUMN notes TEXT;
