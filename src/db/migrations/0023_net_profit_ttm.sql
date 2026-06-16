-- Absolute TTM net profit in crores (Yahoo financialData.netIncomeToCommon / Screener).
-- NULL = not available. Negative = loss-making.
ALTER TABLE fundamentals ADD COLUMN net_profit_ttm REAL;
