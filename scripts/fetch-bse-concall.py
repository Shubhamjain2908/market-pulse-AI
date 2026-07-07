#!/usr/bin/env python3
"""
BSE concall PDF downloader — called as subprocess from Node.js.

Usage:
  python3 scripts/fetch-bse-concall.py <SYMBOL> <OUTPUT_DIR>

Outputs JSON to stdout: {success, symbol, scrip, date, attachment, pdf_path, size, subject, error}

Download strategy (3 tiers):
  1. AttachLive/{UUID} — current filings (primary)
  2. AttachHis/{UUID} — historical archive (fallback if primary 404s)
  3. Company IR website from IR_URL_MAP — direct company-hosted PDF (last resort)
  Each tier is tried for every concall found, not just the latest.
"""
import sys, json, warnings, os
warnings.filterwarnings("ignore")

from bse import BSE
from datetime import datetime, timedelta

# Known BSE scrip codes for symbols that don't resolve via getScripCode
# Add symbols here when BseIndiaApi's getScripCode() returns 404 inconsistently
# Company IR website URLs for symbols where BSE AttachLive/AttachHis fail.
# Scraped for PDF links matching the concall announcement date.
IR_URL_MAP = {
    # Add entries here as needed (e.g., 'KVB': 'https://www.kvbbank.com/investors')
}

MANUAL_SCRIP_CODES = {
    'KIRLOSENG': 533293,
    'BSE': 532155,
    'ABCAPITAL': 540691,
    'AIAENG': 532683,
    'ANGELONE': 543235,
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

            # Step 4: Try to download a concall PDF (iterate through all concalls)
            # Try each concall's PDF through multiple URL patterns until one works
            last_error = "No concall transcripts found"

            for concall in concalls:
                attachment = concall.get('ATTACHMENTNAME', '')
                dt = (concall.get('DT_TM', '') or '')[:10]
                subject = (concall.get('NEWSSUB', '') or '')[:300]

                if not attachment:
                    continue

                # Tier 1: AttachLive (current filings — works for most)
                # Tier 2: AttachHis (historical archive — fallback when file was moved)
                for endpoint in ['AttachLive', 'AttachHis']:
                    pdf_url = f"https://www.bseindia.com/xml-data/corpfiling/{endpoint}/{attachment}"
                    pdf_path = os.path.join(output_dir, f'{symbol}_{endpoint}_{attachment}')

                    try:
                        r = bse._BSE__req(pdf_url, timeout=10)
                        content = r.content

                        if content[:4] == b'%PDF':
                            with open(pdf_path, 'wb') as f:
                                f.write(content)

                            subcat_name = (concall.get('SUBCATNAME', '') or '').lower()
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
                            return  # Success — exit early
                    except Exception as e:
                        last_error = f"{endpoint}: {type(e).__name__}: {str(e)[:200]}"
                        continue

                # Tier 3: Company IR website (for symbols in the known map)
                ir_url = IR_URL_MAP.get(symbol)
                if ir_url:
                    try:
                        import requests as req
                        ir_resp = req.get(ir_url, timeout=10, headers={
                            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
                        })
                        if ir_resp.status_code == 200:
                            # Look for PDF links matching the concall date
                            import re
                            pdf_hrefs = re.findall(r'href=[\'"]([^\'"]+\.pdf)[\'"]', ir_resp.text, re.I)
                            date_slug = dt.replace('-', '') if dt else ''
                            for href in pdf_hrefs:
                                if date_slug and date_slug[:6] in href:
                                    # Found a matching PDF — download it
                                    full_url = href if href.startswith('http') else ir_url.rstrip('/') + '/' + href.lstrip('/')
                                    pdf_resp = req.get(full_url, timeout=10)
                                    if pdf_resp.content[:4] == b'%PDF':
                                        ir_path = os.path.join(output_dir, f'{symbol}_ir_{os.path.basename(href)}')
                                        with open(ir_path, 'wb') as f:
                                            f.write(pdf_resp.content)
                                        print(json.dumps({
                                            "success": True,
                                            "symbol": symbol,
                                            "scrip": scrip,
                                            "date": dt,
                                            "attachment": attachment,
                                            "pdf_path": ir_path,
                                            "size": len(pdf_resp.content),
                                            "subject": subject + ' [company IR fallback]',
                                            "subcategory": 'earnings call transcript',
                                            "kind": 'transcript',
                                        }))
                                        return
                    except Exception:
                        pass

            # All concalls and fallbacks failed
            print(json.dumps({
                "success": False,
                "symbol": symbol,
                "scrip": scrip,
                "total_announcements": len(table),
                "concalls_found": len(concalls),
                "error": f"Download failed: {last_error}",
            }))

    except Exception as e:
        print(json.dumps({
            "success": False,
            "symbol": symbol,
            "error": f"{type(e).__name__}: {str(e)[:300]}",
        }))


if __name__ == '__main__':
    main()
