/**
 * File-based briefing delivery. Writes the rendered HTML to
 * `${BRIEFING_OUTPUT_DIR}/briefing-<date>.html` and records an audit
 * row in the `briefings` table.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import { config } from '../../config/env.js';
import { getDb } from '../../db/index.js';
import { child } from '../../logger.js';

const log = child({ component: 'briefing-delivery-file' });

export interface FileDeliveryResult {
  outPath: string;
  briefingId: number;
}

export function deliverToFile(
  html: string,
  date: string,
  db: DatabaseType = getDb(),
): FileDeliveryResult {
  const outDir = resolve(process.cwd(), config.BRIEFING_OUTPUT_DIR);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `briefing-${date}.html`);
  writeFileSync(outPath, html, 'utf8');

  const insert = db.prepare(`
    INSERT INTO briefings (date, html_content, delivery_method, delivered_at)
    VALUES (?, ?, 'file', datetime('now'))
  `);
  const result = insert.run(date, html);
  const briefingId = Number(result.lastInsertRowid);

  log.info({ outPath, briefingId }, 'briefing delivered to file');
  return { outPath, briefingId };
}
