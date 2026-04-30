/**
 * SQLite connection helper. Single shared, lazily-initialised connection per
 * process. Uses better-sqlite3 (synchronous API) which is the right call here
 * because all our writes are local and bounded.
 */

import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { config } from '../config/env.js';
import { logger } from '../logger.js';

let db: DatabaseType | null = null;

export interface OpenDbOptions {
  /** Override the configured DB path. Used by tests. */
  path?: string;
  /** Open as read-only. */
  readonly?: boolean;
}

export function getDb(opts: OpenDbOptions = {}): DatabaseType {
  if (db && !opts.path) return db;

  const dbPath = resolveDbPath(opts.path ?? config.DATABASE_PATH);
  mkdirSync(dirname(dbPath), { recursive: true });

  const connection = new Database(dbPath, {
    readonly: opts.readonly ?? false,
    fileMustExist: false,
  });

  // PRAGMAs that materially affect correctness/performance for our workload.
  connection.pragma('journal_mode = WAL');
  connection.pragma('synchronous = NORMAL');
  connection.pragma('foreign_keys = ON');
  connection.pragma('busy_timeout = 5000');

  if (!opts.path) db = connection;
  logger.debug({ path: dbPath }, 'sqlite connection opened');
  return connection;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function resolveDbPath(input: string): string {
  return isAbsolute(input) ? input : resolve(process.cwd(), input);
}
