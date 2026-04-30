/**
 * Migration runner. Loads SQL files from `src/db/migrations/` (sorted by
 * filename) and applies any that haven't been recorded in `_migrations`.
 * The base `schema.sql` is treated as migration #0001 and runs on first init.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database as DatabaseType } from 'better-sqlite3';
import { logger } from '../logger.js';
import { getDb } from './connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface MigrationRecord {
  id: string;
  applied_at: string;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export function migrate(db: DatabaseType = getDb()): MigrateResult {
  ensureMigrationsTable(db);

  const applied = new Set(
    db
      .prepare('SELECT id FROM _migrations ORDER BY id')
      .all()
      .map((r) => (r as MigrationRecord).id),
  );

  const result: MigrateResult = { applied: [], skipped: [] };

  const baseSchema = '0001_base_schema';
  if (!applied.has(baseSchema)) {
    const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
    db.exec(sql);
    db.prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, datetime('now'))").run(
      baseSchema,
    );
    result.applied.push(baseSchema);
    logger.info({ migration: baseSchema }, 'applied base schema');
  } else {
    result.skipped.push(baseSchema);
  }

  const migrationsDir = join(__dirname, 'migrations');
  let migrationFiles: string[] = [];
  try {
    migrationFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    // No migrations dir yet - that's fine in Phase 0.
  }

  for (const file of migrationFiles) {
    const id = file.replace(/\.sql$/, '');
    if (applied.has(id)) {
      result.skipped.push(id);
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    db.exec(sql);
    db.prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, datetime('now'))").run(id);
    result.applied.push(id);
    logger.info({ migration: id }, 'applied migration');
  }

  return result;
}

function ensureMigrationsTable(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}
