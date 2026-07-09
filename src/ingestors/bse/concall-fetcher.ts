/**
 * Concall transcript fetcher.
 *
 * For each symbol in the concall universe, spawns `scripts/fetch-bse-concall.py`
 * as a subprocess. The Python script uses BseIndiaApi to:
 *   1. Resolve scrip code
 *   2. Fetch corporate announcements
 *   3. Find latest "Earnings Call Transcript" by subcategory
 *   4. Download PDF via AttachLive/{ATTACHMENTNAME}
 *
 * The PDF buffer is returned, text is extracted via `unpdf`,
 * and persisted to `concall_transcripts`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import { isAllocationInstrument } from '../../agents/portfolio-context.js';
import { config } from '../../config/env.js';
import { loadWatchlist } from '../../config/loaders.js';
import { getDb } from '../../db/connection.js';
import { getLatestHoldings } from '../../db/portfolio-queries.js';
import { getDistinctOpenPaperTradeSymbols, insertConcallTranscript } from '../../db/queries.js';
import { child } from '../../logger.js';
import { isoDateIst } from '../base/dates.js';

const log = child({ component: 'concall-fetcher' });

const PYTHON_SCRIPT = (() => {
  // In dev (tsx), the script lives in scripts/. In production (dist/),
  // it's copied to dist/scripts/ by copy-assets.mjs.
  const dev = join(process.cwd(), 'scripts/fetch-bse-concall.py');
  const prod = join(process.cwd(), 'dist/scripts/fetch-bse-concall.py');
  return existsSync(dev) ? dev : prod;
})();

/** Resolve python3 binary — prefer project venv if it exists. */
const PYTHON_BIN = (() => {
  const venv = join(process.cwd(), '.venv/bin/python3');
  return existsSync(venv) ? venv : 'python3';
})();

// ────────────────────────────────────────────────────────────────────────────
// Shared types (same contract as NSE announcements-fetcher)
// ────────────────────────────────────────────────────────────────────────────

export interface FetchAnnouncementsOptions {
  date?: string;
  db?: DatabaseType;
  signal?: AbortSignal;
  /** Override universe (default: holdings ∪ open paper trades ∪ watchlist). */
  symbols?: string[];
  /** Window days before `date` to search. Default 30. */
  lookbackDays?: number;
  /** @todo implement p-limit concurrency when BseIndiaApi rate-limiting allows it. */
  concurrency?: number;
}

export interface FetchAnnouncementsResult {
  date: string;
  symbolsChecked: number;
  transcriptsFound: number;
  downloaded: number;
  extracted: number;
  failed: number;
  skipped: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Main entry point
// ────────────────────────────────────────────────────────────────────────────

/**
 * Fetch BSE concall transcripts for the configured universe.
 * Spawns the Python script per-symbol, extracts text via `unpdf`, persists.
 * Never throws — returns result counters on any failure.
 */
export async function fetchConcallTranscripts(
  opts: FetchAnnouncementsOptions = {},
): Promise<FetchAnnouncementsResult> {
  const date = opts.date ?? isoDateIst();
  const db = opts.db ?? getDb();
  const lookbackDays = opts.lookbackDays ?? config.CONCALL_LOOKBACK_DAYS;

  // Resolve universe
  const symbols = opts.symbols ?? resolveConcallUniverse(db);
  if (symbols.length === 0) {
    log.info({ date }, 'no symbols in concall universe — skipping');
    return {
      date,
      symbolsChecked: 0,
      transcriptsFound: 0,
      downloaded: 0,
      extracted: 0,
      failed: 0,
      skipped: 0,
    };
  }

  // Filter out non-equity symbols (ETFs, SGBs, gold bonds via isAllocationInstrument)
  const equitySymbols = symbols.filter((s) => !isAllocationInstrument(s));

  log.info(
    { date, total: symbols.length, equity: equitySymbols.length, lookbackDays },
    'concall fetch starting',
  );

  const result: FetchAnnouncementsResult = {
    date,
    symbolsChecked: 0,
    transcriptsFound: 0,
    downloaded: 0,
    extracted: 0,
    failed: 0,
    skipped: 0,
  };

  // Process symbols sequentially (BseIndiaApi has its own rate limiting)
  for (const symbol of equitySymbols) {
    result.symbolsChecked++;

    if (opts.signal?.aborted) {
      log.warn({ symbol }, 'concall fetch aborted mid-run');
      break;
    }

    try {
      await processSymbol(symbol, result, db, opts.signal);
    } catch (err) {
      log.warn({ symbol, err: (err as Error).message }, 'symbol processing failed');
      result.failed++;
    }
  }

  log.info(
    {
      date,
      symbolsChecked: result.symbolsChecked,
      transcriptsFound: result.transcriptsFound,
      downloaded: result.downloaded,
      extracted: result.extracted,
      failed: result.failed,
      skipped: result.skipped,
    },
    'concall fetch complete',
  );
  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// Per-symbol processing
// ────────────────────────────────────────────────────────────────────────────

async function processSymbol(
  symbol: string,
  result: FetchAnnouncementsResult,
  db: DatabaseType,
  signal?: AbortSignal,
): Promise<void> {
  // Create temp dir for this symbol's PDF
  const tmpDir = mkdtempSync(join(tmpdir(), `bse-concall-${symbol}-`));

  try {
    // Step 1: Spawn Python subprocess
    const proc = spawnSync(PYTHON_BIN, [PYTHON_SCRIPT, symbol, tmpDir], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      timeout: 30_000, // 30s per symbol
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    });

    if (proc.error) {
      log.warn({ symbol, err: proc.error.message }, 'python subprocess failed');
      result.failed++;
      return;
    }

    // Parse JSON from stdout (last line)
    const stdoutLines = proc.stdout.trim().split('\n').filter(Boolean);
    if (stdoutLines.length === 0) {
      log.warn({ symbol, stderr: proc.stderr.slice(0, 200) }, 'no stdout from python script');
      result.failed++;
      return;
    }

    const jsonLine = stdoutLines[stdoutLines.length - 1];
    if (!jsonLine) {
      log.warn({ symbol }, 'empty stdout from python script');
      result.failed++;
      return;
    }
    let pythonResult: PythonResult;
    try {
      pythonResult = JSON.parse(jsonLine);
    } catch {
      log.warn({ symbol, stdout: jsonLine.slice(0, 200) }, 'invalid JSON from python script');
      result.failed++;
      return;
    }

    if (!pythonResult.success) {
      log.warn({ symbol, error: pythonResult.error }, 'python script reported failure');
      result.failed++;
      return;
    }

    result.transcriptsFound++;

    // Step 2: Check if PDF downloaded
    if (!pythonResult.pdf_path || !existsSync(pythonResult.pdf_path)) {
      log.warn({ symbol }, 'python script succeeded but no PDF file found');
      result.failed++;
      return;
    }

    // Step 3: Extract text via unpdf
    const pdfBuffer = readFileSync(pythonResult.pdf_path);
    const text = await extractPdfText(pdfBuffer);
    const charCount = text.length;

    if (charCount < 2000) {
      log.warn({ symbol, charCount }, 'transcript PDF too short — skipping (image-only)');
      result.skipped++;
      return;
    }

    // Detect invitation PDFs masquerading as transcripts (BSE uses "Earnings Call Transcript"
    // as SUBCATNAME for both invites and actual transcripts). Check first 2000 chars for    // invitation language — narrow keyword set to minimize false positives.
    const isInvite =
      /\b(invitation|cordially\s+invited|notice\s+of\s+(conference|earnings|board)|you\s+are\s+(cordially\s+)?invited|intimation\s+(of\s+)?(conference|earnings|board))\b/i.test(
        text.slice(0, 2000),
      );
    if (isInvite) {
      log.info(
        { symbol, charCount },
        'PDF appears to be an invitation, not a transcript — marking as invite',
      );
      // Override kind so the concall analyser's WHERE ct.kind = 'transcript' filter skips it
      pythonResult.kind = 'invite';
    }

    // Step 4: Insert into concall_transcripts
    const announcedAt =
      pythonResult.date && pythonResult.date.length >= 10
        ? pythonResult.date.substring(0, 10)
        : dateString();

    const attachmentUrl = pythonResult.attachment
      ? `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${pythonResult.attachment}`
      : '';

    const inserted = insertConcallTranscript(
      {
        symbol,
        announcedAt,
        attachmentUrl,
        kind: pythonResult.kind ?? 'transcript',
        text,
        charCount,
      },
      db,
    );

    if (inserted) {
      result.downloaded++;
      result.extracted++;
      log.info(
        { symbol, date: announcedAt, chars: charCount, size: pythonResult.size },
        'concall transcript ingested',
      );
    } else {
      result.skipped++;
      log.info({ symbol, date: announcedAt }, 'concall transcript already exists (skipped)');
    }
  } finally {
    // Cleanup temp dir
    try {
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Date helpers (moved before `processSymbol` for readability)
// ────────────────────────────────────────────────────────────────────────────

function dateString(): string {
  return new Date().toISOString().slice(0, 10);
}

// ────────────────────────────────────────────────────────────────────────────
// PDF text extraction (reuse same pattern as NSE announcements-fetcher)
// ────────────────────────────────────────────────────────────────────────────

async function extractPdfText(buf: Uint8Array | Buffer): Promise<string> {
  try {
    const { getDocumentProxy, extractText } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    return (text ?? '').trim();
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'PDF text extraction failed');
    return '';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Python result type
// ────────────────────────────────────────────────────────────────────────────

interface PythonResult {
  success: boolean;
  symbol?: string;
  scrip?: number;
  date?: string;
  attachment?: string;
  pdf_path?: string;
  size?: number;
  subject?: string;
  subcategory?: string;
  kind?: string;
  error?: string;
  total_announcements?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Universe resolution (mirrors NSE announcements-fetcher)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resolve universe for concall fetching: holdings ∪ open paper trades ∪ watchlist.
 * Symbols are merged and deduped.
 */
function resolveConcallUniverse(db: DatabaseType): string[] {
  const set = new Set<string>();

  // Add holdings
  for (const h of getLatestHoldings(db)) {
    set.add(h.symbol.toUpperCase());
  }

  // Add open paper trades
  for (const s of getDistinctOpenPaperTradeSymbols(db)) {
    set.add(s.toUpperCase());
  }

  // Add watchlist
  try {
    for (const s of loadWatchlist().symbols) {
      set.add(s.toUpperCase());
    }
  } catch {
    // Watchlist may not be configured
  }

  return [...set].sort();
}
