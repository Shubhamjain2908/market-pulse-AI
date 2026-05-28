#!/usr/bin/env python3
import argparse
import datetime as dt
import json
import logging
import sqlite3
import time
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import pandas as pd
import yfinance as yf
from nse import NSE


# Hardcoded NSE symbols (~230) for batch backfill.
SYMBOLS: List[str] = [
    "RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "TCS", "SBIN", "LT", "BHARTIARTL",
    "ITC", "KOTAKBANK", "AXISBANK", "BAJFINANCE", "HINDUNILVR", "SUNPHARMA", "M&M",
    "MARUTI", "ULTRACEMCO", "NESTLEIND", "WIPRO", "POWERGRID", "NTPC", "ONGC",
    "TECHM", "TITAN", "ASIANPAINT", "HCLTECH", "TATASTEEL", "ADANIENT", "ADANIPORTS",
    "INDIGO", "COALINDIA", "JSWSTEEL", "DRREDDY", "EICHERMOT", "BAJAJFINSV", "BEL",
    "BAJAJ-AUTO", "CIPLA", "GRASIM", "HDFCLIFE", "HEROMOTOCO", "APOLLOHOSP",
    "BAJAJHLDNG", "BPCL", "DMART", "AMBUJACEM", "SIEMENS", "DIVISLAB", "TATAPOWER",
    "HINDALCO", "JIOFIN", "SBILIFE", "SHRIRAMFIN", "TRENT", "ABB", "BANKBARODA",
    "BRITANNIA", "BOSCHLTD", "CANBK", "CHOLAFIN", "CUMMINSIND", "DLF", "GAIL",
    "GODREJCP", "HAL", "HDFCAMC", "HINDZINC", "INDHOTEL", "IOC", "IRFC", "JINDALSTEL",
    "LODHA", "LTM", "MAZDOCK", "MUTHOOTFIN", "PFC", "PIDILITIND", "PNB", "RECLTD",
    "MOTHERSON", "SHREECEM", "SOLARINDS", "TVSMOTOR", "TATACAP", "TATACONSUM",
    "TORNTPHARM", "UNIONBANK", "VBL", "VEDL", "ZYDUSLIFE", "AUBANK", "ALKEM",
    "ASHOKLEY", "AUROPHARMA", "BSE", "BHARATFORG", "BHEL", "COFORGE", "COLPAL",
    "DABUR", "DIXON", "FEDERALBNK", "FORTIS", "GMRAIRPORT", "GODREJPROP", "HAVELLS",
    "HINDPETRO", "ICICIGI", "IDFCFIRSTB", "INDUSINDBK", "INDUSTOWER", "NAUKRI",
    "LAURUSLABS", "LUPIN", "MANKIND", "MARICO", "MFSL", "MCX", "MPHASIS", "NHPC",
    "NMDC", "OIL", "PAYTM", "POLICYBZR", "PERSISTENT", "PHOENIXLTD", "POLYCAB",
    "PRESTIGE", "SBICARD", "SRF", "SUPREMEIND", "SUZLON", "SWIGGY", "TIINDIA", "UPL",
    "WAAREEENER", "YESBANK", "360ONE", "3MINDIA", "ACC", "AIAENG", "AWL", "ABBOTINDIA",
    "ATGL", "ABCAPITAL", "AJANTPHARM", "APARINDS", "APOLLOTYRE", "ASTRAL", "BALKRISIND",
    "BANKINDIA", "MAHABANK", "BERGEPAINT", "BDL", "BIOCON", "BLUESTARCO", "CRISIL",
    "COCHINSHIP", "CONCOR", "COROMANDEL", "DALBHARAT", "ESCORTS", "EXIDEIND", "GICRE",
    "GLAXO", "GLENMARK", "GODFRYPHLP", "GODREJIND", "FLUOROCHEM", "HUDCO", "ICICIPRULI",
    "INDIANB", "IRCTC", "IREDA", "IPCALAB", "JKCEMENT", "JSWENERGY", "JSWINFRA",
    "JSL", "JUBLFOOD", "KPRMILL", "KEI", "KPITTECH", "KALYANKJIL", "LTF", "LTTS",
    "LICHSGFIN", "LICI", "LINDEINDIA", "M&MFIN", "MOTILALOFS", "NLCINDIA", "NATIONALUM",
    "NAM-INDIA", "OBEROIRLTY", "OFSS", "PIIND", "PAGEIND", "PATANJALI", "PETRONET",
    "RADICO", "RVNL", "SJVN", "SCHAEFFLER", "SAIL", "SUNDARMFIN", "TATACOMM", "TATAELXSI",
    "NIACL", "THERMAX", "TORNTPOWER", "UNOMINDA", "UBL", "IDEA", "VOLTAS", "ACMESOLAR",
    "AARTIIND", "AAVAS", "ABFRL", "ABSLAMC", "AEGISLOG", "AFCONS", "AFFLE", "ARE&M",
    "AMBER", "ANANDRATHI", "ANANTRAJ", "ANGELONE", "APTUS", "ASAHIINDIA", "ATUL", "BEML",
    "BLS", "BALRAMCHIN", "BANDHANBNK", "BATAINDIA", "BAYERCROP", "BIKAJI", "BSOFT",
    "BLUEDART", "BRIGADE",
]

YAHOO_TICKER_EXCEPTIONS = {
    "M&M": "M&M.NS",
    "BAJAJ-AUTO": "BAJAJ-AUTO.NS",
    "ARE&M": "ARE&M.NS",
    "NAM-INDIA": "NAM-INDIA.NS",
}

TARGET_YEARS = {2022, 2023, 2024, 2025, 2026}
AUDIT_QUERY = """
SELECT symbol, COUNT(*) AS annual_rows, MIN(as_of), MAX(as_of),
  SUM(CASE WHEN roe IS NOT NULL THEN 1 ELSE 0 END) AS roe_populated
FROM fundamentals WHERE source='yahoo_annual'
GROUP BY symbol HAVING annual_rows >= 3
ORDER BY annual_rows DESC;
"""


@dataclass
class PromoterQuarter:
    as_of: str
    pct: Optional[float]
    change_qoq: Optional[float]


def setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Backfill fundamentals table using Yahoo + NSE shareholding data."
    )
    parser.add_argument("--db", required=True, help="Path to SQLite database file.")
    parser.add_argument(
        "--delay",
        type=float,
        default=1.0,
        help="Delay (seconds) between symbols. Default: 1.0",
    )
    parser.add_argument("--symbols", default="", help="Comma-separated subset for testing")
    return parser.parse_args()


def ensure_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS fundamentals (
          symbol                       TEXT NOT NULL,
          as_of                        TEXT NOT NULL,
          market_cap                   REAL,
          pe                           REAL,
          pb                           REAL,
          peg                          REAL,
          roe                          REAL,
          roce                         REAL,
          revenue_growth_yoy           REAL,
          profit_growth_yoy            REAL,
          debt_to_equity               REAL,
          promoter_holding_pct         REAL,
          promoter_holding_change_qoq  REAL,
          dividend_yield               REAL,
          source                       TEXT NOT NULL,
          ingested_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (symbol, as_of)
        );
        """
    )
    conn.commit()


def to_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, str):
        value = value.strip().replace(",", "")
        if value in {"", "-", "--", "NA", "N/A", "null"}:
            return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    if pd.isna(out):
        return None
    return out


def safe_div(numerator: Optional[float], denominator: Optional[float]) -> Optional[float]:
    if numerator is None or denominator in (None, 0):
        return None
    return numerator / denominator


def growth(curr: Optional[float], prev: Optional[float]) -> Optional[float]:
    if curr is None or prev in (None, 0):
        return None
    return (curr - prev) / prev


def date_to_iso(date_obj: Any) -> Optional[str]:
    if isinstance(date_obj, pd.Timestamp):
        return date_obj.date().isoformat()
    if isinstance(date_obj, dt.datetime):
        return date_obj.date().isoformat()
    if isinstance(date_obj, dt.date):
        return date_obj.isoformat()
    return None


def map_symbol_to_yahoo(symbol: str) -> str:
    return YAHOO_TICKER_EXCEPTIONS.get(symbol, f"{symbol}.NS")


def frame_value(frame: pd.DataFrame, labels: Sequence[str], col: Any) -> Optional[float]:
    if frame is None or frame.empty or col not in frame.columns:
        return None
    for label in labels:
        if label in frame.index:
            return to_float(frame.at[label, col])
    return None


def collect_annual_rows(symbol: str, ticker: yf.Ticker) -> List[Dict[str, Any]]:
    income = ticker.income_stmt
    balance = ticker.balance_sheet
    if income is None or income.empty or balance is None or balance.empty:
        return []

    date_candidates = [c for c in income.columns if hasattr(c, "year")]
    years_to_col: Dict[int, Any] = {}
    for col in sorted(date_candidates, reverse=True):
        if col.year in TARGET_YEARS and col.year not in years_to_col:
            years_to_col[col.year] = col

    annual_rows: List[Dict[str, Any]] = []
    for year in sorted(years_to_col):
        col = years_to_col[year]
        prev_col = years_to_col.get(year - 1)

        net_income = frame_value(income, ["Net Income", "NetIncome"], col)
        revenue = frame_value(income, ["Total Revenue", "Revenue"], col)
        ebit = frame_value(income, ["EBIT", "Operating Income"], col)
        total_assets = frame_value(balance, ["Total Assets"], col)
        current_liabilities = frame_value(balance, ["Current Liabilities"], col)
        equity = frame_value(
            balance,
            ["Stockholders Equity", "Total Stockholder Equity", "Common Stock Equity"],
            col,
        )
        total_debt = frame_value(
            balance,
            ["Total Debt", "Total Liabilities Net Minority Interest", "Long Term Debt"],
            col,
        )

        prev_revenue = frame_value(income, ["Total Revenue", "Revenue"], prev_col) if prev_col else None
        prev_profit = frame_value(income, ["Net Income", "NetIncome"], prev_col) if prev_col else None
        prev_equity = frame_value(
            balance,
            ["Stockholders Equity", "Total Stockholder Equity", "Common Stock Equity"],
            prev_col,
        ) if prev_col else None

        avg_equity = None
        if equity is not None and prev_equity is not None:
            avg_equity = (equity + prev_equity) / 2.0

        as_of = date_to_iso(col)
        if not as_of:
            continue

        annual_rows.append(
            {
                "symbol": symbol,
                "as_of": as_of,
                "market_cap": None,
                "pe": None,
                "pb": None,
                "peg": None,
                "roe": safe_div(net_income, avg_equity),
                "roce": safe_div(ebit, (total_assets - current_liabilities) if total_assets is not None and current_liabilities is not None else None),
                "revenue_growth_yoy": growth(revenue, prev_revenue),
                "profit_growth_yoy": growth(net_income, prev_profit),
                "debt_to_equity": safe_div(total_debt, equity),
                "promoter_holding_pct": None,
                "promoter_holding_change_qoq": None,
                "dividend_yield": None,
                "source": "yahoo_annual",
            }
        )

    return annual_rows


def collect_snapshot_row(symbol: str, ticker: yf.Ticker) -> Dict[str, Any]:
    info = ticker.info or {}
    d2e_raw = to_float(info.get("debtToEquity"))
    debt_to_equity = round(d2e_raw / 100, 6) if d2e_raw is not None else None

    row = {
        "symbol": symbol,
        "as_of": dt.date.today().isoformat(),
        "market_cap": to_float(info.get("marketCap")),
        "pe": to_float(info.get("trailingPE")),
        "pb": to_float(info.get("priceToBook")),
        "peg": to_float(info.get("pegRatio")),
        "roe": to_float(info.get("returnOnEquity")),
        "roce": None,
        "revenue_growth_yoy": to_float(info.get("revenueGrowth")),
        "profit_growth_yoy": to_float(info.get("earningsGrowth")),
        "debt_to_equity": debt_to_equity,
        "promoter_holding_pct": None,
        "promoter_holding_change_qoq": None,
        "dividend_yield": to_float(info.get("dividendYield")),
        "source": "yahoo_snapshot",
    }
    return row


def parse_nse_date(value: Any) -> Optional[dt.date]:
    if not value:
        return None
    if isinstance(value, dt.date):
        return value
    if isinstance(value, str):
        for fmt in ("%d-%b-%Y", "%d-%B-%Y", "%Y-%m-%d"):
            try:
                return dt.datetime.strptime(value.strip(), fmt).date()
            except ValueError:
                continue
    return None


def collect_promoter_rows(nse_client: NSE, symbol: str, max_quarters: int = 8) -> List[PromoterQuarter]:
    raw = nse_client.shareholding(symbol=symbol, index="equities")
    if not isinstance(raw, list):
        return []

    parsed: List[Tuple[dt.date, float]] = []
    for rec in raw:
        date_value = parse_nse_date(rec.get("date"))
        pct = to_float(rec.get("pr_and_prgrp"))
        if date_value is None or pct is None:
            continue
        parsed.append((date_value, pct))

    if not parsed:
        return []

    # Deduplicate by date and keep most recent observation.
    by_date: Dict[dt.date, float] = {}
    for d, pct in parsed:
        by_date[d] = pct

    latest_desc = sorted(by_date.items(), key=lambda x: x[0], reverse=True)[:max_quarters]
    chronological = sorted(latest_desc, key=lambda x: x[0])

    output: List[PromoterQuarter] = []
    prev_pct: Optional[float] = None
    for q_date, pct in chronological:
        change = round(pct - prev_pct, 4) if prev_pct is not None else None
        output.append(PromoterQuarter(as_of=q_date.isoformat(), pct=pct, change_qoq=change))
        prev_pct = pct
    return output


def insert_or_ignore_row(conn: sqlite3.Connection, row: Dict[str, Any]) -> int:
    insert_clause = "INSERT OR REPLACE" if row.get("source") == "yahoo_annual" else "INSERT OR IGNORE"
    result = conn.execute(
        f"""
        {insert_clause} INTO fundamentals (
          symbol, as_of, market_cap, pe, pb, peg, roe, roce,
          revenue_growth_yoy, profit_growth_yoy, debt_to_equity,
          promoter_holding_pct, promoter_holding_change_qoq, dividend_yield, source, ingested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        """,
        (
            row["symbol"],
            row["as_of"],
            row["market_cap"],
            row["pe"],
            row["pb"],
            row["peg"],
            row["roe"],
            row["roce"],
            row["revenue_growth_yoy"],
            row["profit_growth_yoy"],
            row["debt_to_equity"],
            row["promoter_holding_pct"],
            row["promoter_holding_change_qoq"],
            row["dividend_yield"],
            row["source"],
        ),
    )
    return result.rowcount


def upsert_promoter_row(
    conn: sqlite3.Connection,
    symbol: str,
    promoter_row: PromoterQuarter,
    nearest_day_tolerance: int = 60,
) -> str:
    nearest = conn.execute(
        """
        SELECT as_of, ABS(julianday(as_of) - julianday(?)) AS day_diff
        FROM fundamentals
        WHERE symbol = ?
        ORDER BY day_diff ASC
        LIMIT 1
        """,
        (promoter_row.as_of, symbol),
    ).fetchone()

    if nearest and nearest[1] is not None and float(nearest[1]) <= nearest_day_tolerance:
        conn.execute(
            """
            UPDATE fundamentals
            SET promoter_holding_pct = ?, promoter_holding_change_qoq = ?
            WHERE symbol = ? AND as_of = ?
            """,
            (promoter_row.pct, promoter_row.change_qoq, symbol, nearest[0]),
        )
        return "updated"

    result = conn.execute(
        """
        INSERT OR IGNORE INTO fundamentals (
          symbol, as_of, market_cap, pe, pb, peg, roe, roce,
          revenue_growth_yoy, profit_growth_yoy, debt_to_equity,
          promoter_holding_pct, promoter_holding_change_qoq, dividend_yield, source, ingested_at
        ) VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, 'nse_shareholding', CURRENT_TIMESTAMP)
        """,
        (symbol, promoter_row.as_of, promoter_row.pct, promoter_row.change_qoq),
    )
    if result.rowcount == 0:
        conn.execute(
            """
            UPDATE fundamentals
            SET promoter_holding_pct = ?, promoter_holding_change_qoq = ?
            WHERE symbol = ? AND as_of = ?
            """,
            (promoter_row.pct, promoter_row.change_qoq, symbol, promoter_row.as_of),
        )
        return "updated"
    return "inserted"


def write_errors(errors: List[Dict[str, Any]], output_file: Path) -> None:
    output_file.write_text(json.dumps(errors, indent=2), encoding="utf-8")


def run_audit(conn: sqlite3.Connection) -> int:
    rows = conn.execute(AUDIT_QUERY).fetchall()
    for row in rows:
        print(row)
    print(f"\nAudit row count (annual_rows >= 3): {len(rows)}")
    if len(rows) >= 100:
        print("SUCCESS GATE: PASS (>=100 symbols)")
    else:
        print("SUCCESS GATE: FAIL (<100 symbols)")
    return len(rows)


def main() -> None:
    args = parse_args()
    setup_logging()

    db_path = Path(args.db)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL;")
    ensure_table(conn)

    errors: List[Dict[str, Any]] = []
    symbols = SYMBOLS
    if args.symbols.strip():
        requested = [s.strip() for s in args.symbols.split(",") if s.strip()]
        requested_set = set(requested)
        symbols = [s for s in SYMBOLS if s in requested_set]
        missing = sorted(requested_set - set(symbols))
        if missing:
            logging.warning("Requested symbols not in hardcoded list: %s", ",".join(missing))
    total = len(symbols)
    if total == 0:
        logging.error("No symbols to process after --symbols filter.")
        conn.close()
        return

    with NSE(download_folder=Path("."), server=False) as nse_client:
        for idx, symbol in enumerate(symbols, start=1):
            logging.info("[%d/%d] %s", idx, total, symbol)
            symbol_errors: List[Dict[str, str]] = []

            try:
                yahoo_ticker = map_symbol_to_yahoo(symbol)
                ticker = yf.Ticker(yahoo_ticker)
            except Exception as exc:
                symbol_errors.append({"stage": "ticker_init", "error": str(exc)})
                ticker = None

            # Annual ingestion
            annual_inserted, annual_skipped = 0, 0
            if ticker is not None:
                try:
                    annual_rows = collect_annual_rows(symbol, ticker)
                    for row in annual_rows:
                        count = insert_or_ignore_row(conn, row)
                        if count > 0:
                            annual_inserted += 1
                        else:
                            annual_skipped += 1
                    logging.info("  annual: inserted=%d skipped=%d", annual_inserted, annual_skipped)
                except Exception:
                    symbol_errors.append(
                        {"stage": "annual", "error": traceback.format_exc(limit=1).strip()}
                    )
                    logging.exception("  annual: failed")
            else:
                logging.info("  annual: skipped (ticker init failed)")

            # Snapshot ingestion
            if ticker is not None:
                try:
                    snapshot_row = collect_snapshot_row(symbol, ticker)
                    snap_count = insert_or_ignore_row(conn, snapshot_row)
                    logging.info("  snapshot: %s", "inserted" if snap_count > 0 else "skipped")
                except Exception:
                    symbol_errors.append(
                        {"stage": "snapshot", "error": traceback.format_exc(limit=1).strip()}
                    )
                    logging.exception("  snapshot: failed")
            else:
                logging.info("  snapshot: skipped (ticker init failed)")

            # Promoter shareholding ingestion
            promoter_inserted, promoter_updated = 0, 0
            try:
                quarters = collect_promoter_rows(nse_client, symbol, max_quarters=8)
                for q in quarters:
                    action = upsert_promoter_row(conn, symbol, q)
                    if action == "inserted":
                        promoter_inserted += 1
                    else:
                        promoter_updated += 1
                logging.info(
                    "  promoter: quarters=%d inserted=%d updated=%d",
                    len(quarters),
                    promoter_inserted,
                    promoter_updated,
                )
            except Exception:
                symbol_errors.append(
                    {"stage": "promoter", "error": traceback.format_exc(limit=1).strip()}
                )
                logging.exception("  promoter: failed")

            conn.commit()

            if symbol_errors:
                errors.append({"symbol": symbol, "errors": symbol_errors})

            time.sleep(max(args.delay, 0))

    error_file = db_path.parent / "backfill_errors.json"
    write_errors(errors, error_file)
    logging.info("Wrote error report: %s (symbols with errors: %d)", error_file, len(errors))

    run_audit(conn)
    conn.close()


if __name__ == "__main__":
    main()
