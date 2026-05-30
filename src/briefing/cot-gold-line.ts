/**
 * One-line COMEX gold COT macro hint for the regime section (crowded positioning only).
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { type CotGoldClassification, classifyCotGoldRatio } from '../cot/gold-cot.js';
import { getLatestCotGold } from '../db/queries.js';
import { THEME } from './template.js';

function esc(s: string | number): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function labelFor(classification: CotGoldClassification): string {
  if (classification === 'CROWDED_LONG') return 'CROWDED LONG';
  if (classification === 'CROWDED_SHORT') return 'CROWDED SHORT';
  return 'NEUTRAL';
}

/** HTML fragment or empty when latest COT is NEUTRAL / missing. */
export function renderCotGoldMacroLine(db: DatabaseType): string {
  const row = getLatestCotGold(db);
  if (!row) return '';

  const classification = classifyCotGoldRatio(row.mmNetOiRatio);
  if (classification === 'NEUTRAL') return '';

  const c = THEME;
  const pct = (row.mmNetOiRatio * 100).toFixed(1);
  const text = `COMEX Gold COT (${row.reportDate}): managed-money net/OI ${pct}% — ${labelFor(classification)}.`;

  return `
    <p class="cot-gold-macro" style="margin:0 0 10px;padding:8px 10px;border-left:3px solid ${c.border};background:rgba(255,255,255,0.45);font-size:13px;line-height:1.45;color:${c.text};">
      ${esc(text)}
    </p>`;
}
