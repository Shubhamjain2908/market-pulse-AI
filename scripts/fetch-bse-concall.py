#!/usr/bin/env python3
"""
BSE concall PDF downloader — called as subprocess from Node.js.

Usage:
  python3 scripts/fetch-bse-concall.py <SYMBOL> <OUTPUT_DIR>

Outputs JSON to stdout: {success, symbol, scrip, date, attachment, pdf_path, size, subject, error}

Implementation:
  1. Gets BSE scrip code for the symbol (with manual fallback for known symbols)
  2. Fetches corporate announcements for the trailing 12 months
  3. Filters to "Earnings Call Transcript" by SUBCATNAME
  4. Downloads the latest transcript PDF via AttachLive/{ATTACHMENTNAME}
  5. Saves to output dir, prints JSON result
"""
import sys, json, warnings, os
warnings.filterwarnings("ignore")

from bse import BSE
from datetime import datetime, timedelta

# Known BSE scrip codes for symbols that don't resolve via getScripCode
MANUAL_SCRIP_CODES = {
    'KIRLOSENG': 533293,
    'BSE': 532155,
}

def main():
    if len(sys.argv) < 3:
        print(json.dumps({
            "success": False,
            "symbol": sys.argv[1] if len(sys.argv) > 1 else "?",
            "error": "Usage: fetch-bse-concall.py SYMBOL OUTPUT_DIR",
        }))
        sys.exit(0)

    symbol = sys.argv[1].strip().upper()
    output_dir = sys.argv[2]

    os.makedirs(output_dir, exist_ok=True)

    try:
        with BSE(download_folder=output_dir) as bse:
            # Step 1: Get BSE scrip code
            try:
                if symbol in MANUAL_SCRIP_CODES:
                    scrip = MANUAL_SCRIP_CODES[symbol]
                else:
                    scrip = bse.getScripCode(symbol)
            except ValueError as e:
                print(json.dumps({
                    "success": False,
                    "symbol": symbol,
                    "error": f"Scrip code not found: {str(e)[:200]}",
                }))
                return

            if not scrip:
                print(json.dumps({
                    "success": False,
                    "symbol": symbol,
                    "error": "Scrip code lookup returned empty",
                }))
                return

            # Step 2: Fetch announcements (trailing 12 months)
            to_date = datetime.now()
            from_date = to_date - timedelta(days=365)

            data = bse.announcements(
                scripcode=scrip,
                from_date=from_date,
                to_date=to_date,
                segment='equity',
            )

            table = data.get('Table', [])
            if not table:
                print(json.dumps({
                    "success": False,
                    "symbol": symbol,
                    "scrip": scrip,
                    "error": "No announcements returned from BSE API",
                }))
                return

            # Step 3: Find concall transcripts
            concalls = []
            for row in table:
                subcat = (row.get('SUBCATNAME', '') or '').lower()
                sub = (row.get('NEWSSUB', '') or '').lower()
                attch = (row.get('ATTACHMENTNAME', '') or '').lower()
                # Match: "Earnings Call Transcript" or similar patterns
                if ('transcript' in subcat or 'concall' in subcat or
                    'conference call' in subcat or
                    ('transcript' in sub and 'call' in sub)):
                    concalls.append(row)

            if not concalls:
                # Fallback: try any announcement with a PDF attachment that looks like a concall
                for row in table:
                    subcat = (row.get('SUBCATNAME', '') or '').lower()
                    sub = (row.get('NEWSSUB', '') or '').lower()
                    attch = (row.get('ATTACHMENTNAME', '') or '').lower()
                    if attch.endswith('.pdf') and ('earnings' in subcat or 'result' in subcat or
                                                   'analyst' in sub or 'investor' in sub):
                        if 'meet' in sub.lower():
                            continue
                        concalls.append(row)

            if not concalls:
                print(json.dumps({
                    "success": False,
                    "symbol": symbol,
                    "scrip": scrip,
                    "total_announcements": len(table),
                    "error": "No concall transcripts found in announcements",
                }))
                return

            # Step 4: Download the latest concall PDF
            latest = concalls[0]
            attachment = latest.get('ATTACHMENTNAME', '')
            dt = (latest.get('DT_TM', '') or '')[:10]
            subject = (latest.get('NEWSSUB', '') or '')[:300]

            if not attachment:
                print(json.dumps({
                    "success": False,
                    "symbol": symbol,
                    "scrip": scrip,
                    "error": "Latest concall has no ATTACHMENTNAME",
                }))
                return

            pdf_url = f"https://www.bseindia.com/xml-data/corpfiling/AttachLive/{attachment}"
            pdf_path = os.path.join(output_dir, f'{symbol}_{attachment}')

            r = bse._BSE__req(pdf_url)
            content = r.content

            if content[:4] != b'%PDF':
                print(json.dumps({
                    "success": False,
                    "symbol": symbol,
                    "scrip": scrip,
                    "error": f"Not a PDF (starts with {content[:20].hex()})",
                }))
                return

            with open(pdf_path, 'wb') as f:
                f.write(content)

            # Step 5: Determine subject category
            subcat_name = (latest.get('SUBCATNAME', '') or '').lower()
            kind = 'transcript' if 'transcript' in subcat_name else 'invite'

            print(json.dumps({
                "success": True,
                "symbol": symbol,
                "scrip": scrip,
                "date": dt,
                "attachment": attachment,
                "pdf_path": pdf_path,
                "size": len(content),
                "subject": subject,
                "subcategory": subcat_name,
                "kind": kind,
            }))

    except Exception as e:
        print(json.dumps({
            "success": False,
            "symbol": symbol,
            "error": f"{type(e).__name__}: {str(e)[:300]}",
        }))


if __name__ == '__main__':
    main()
