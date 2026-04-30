#!/usr/bin/env node
/**
 * Post-build asset copier. Mirrors non-TS files (SQL schemas, JSON templates)
 * from src/ into dist/ so the compiled CLI can find them at runtime.
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

const ASSETS = [
  { from: 'src/db/schema.sql', to: 'dist/db/schema.sql' },
  { from: 'src/db/migrations', to: 'dist/db/migrations', optional: true },
];

let copied = 0;
for (const { from, to, optional } of ASSETS) {
  const src = join(root, from);
  const dest = join(root, to);
  if (!existsSync(src)) {
    if (optional) continue;
    console.error(`[copy-assets] missing required asset: ${from}`);
    process.exitCode = 1;
    continue;
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  copied++;
  console.log(`[copy-assets] ${from} -> ${to}`);
}
console.log(`[copy-assets] done (${copied} assets)`);
