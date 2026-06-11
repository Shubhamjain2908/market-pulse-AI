-- Hot-path read indexes. Audit 2026-06-11.
-- Append-only. Do not edit prior migrations.

-- Covering index for getLatestSignalsMap / getLatestSignalsMapsForSymbols
-- window-function pattern: filter symbol+name, sort date DESC.
-- Replaces the two separate (date,name) and (symbol) indexes for this query.
CREATE INDEX IF NOT EXISTS idx_signals_symbol_name_date
  ON signals(symbol, name, date DESC);

-- PIT query support: as_of <= ? in momentum-ranker and
-- getQualityGarpFundamentals CTEs.
CREATE INDEX IF NOT EXISTS idx_fundamentals_asof
  ON fundamentals(as_of);

-- Briefing per-symbol news lookup: symbol filter + date sort.
CREATE INDEX IF NOT EXISTS idx_news_symbol_published
  ON news(symbol, published_at DESC);

-- Replace full-column status index with partial index.
-- Only OPEN trades are hot; CLOSED are cold reads.
DROP INDEX IF EXISTS idx_paper_trades_status;
CREATE INDEX IF NOT EXISTS idx_pt_open
  ON paper_trades(symbol) WHERE status = 'OPEN';

-- Covering index for Quality-GARP LatestPerSource CTE:
-- ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY as_of DESC)
-- filtered by source.
CREATE INDEX IF NOT EXISTS idx_fundamentals_source_symbol_asof
  ON fundamentals(source, symbol, as_of DESC);

-- Update query planner statistics after index creation.
ANALYZE;
