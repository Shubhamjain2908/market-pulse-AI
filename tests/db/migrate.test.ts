import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, migrate } from '../../src/db/index.js';

describe('db/migrate', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-test-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = dbPath;
  });

  afterEach(() => {
    closeDb();
    try {
      rmSync(dbPath);
      rmSync(`${dbPath}-wal`);
      rmSync(`${dbPath}-shm`);
    } catch {
      // best effort cleanup
    }
  });

  it('applies the base schema on first run', () => {
    const db = getDb({ path: dbPath });
    const result = migrate(db);
    expect(result.applied).toContain('0001_base_schema');
    expect(result.skipped).toEqual([]);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);

    expect(tables).toContain('quotes');
    expect(tables).toContain('signals');
    expect(tables).toContain('screens');
    expect(tables).toContain('briefings');
    expect(tables).toContain('_migrations');
    db.close();
  });

  it('is idempotent on subsequent runs', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    const second = migrate(db);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('0001_base_schema');
    db.close();
  });
});
