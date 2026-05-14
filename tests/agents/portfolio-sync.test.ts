import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, migrate } from '../../src/db/index.js';
import { resolveKiteAccessToken } from '../../src/agents/portfolio-sync.js';

describe('portfolio-sync token source precedence', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-ps-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = dbPath;
    db = getDb({ path: dbPath });
    migrate(db);
  });

  afterEach(() => {
    db.close();
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(`${dbPath}${suffix}`);
      } catch {
        // best effort
      }
    }
  });

  it('prefers config.kite_access_token over env token', () => {
    db.prepare(
      `
      INSERT INTO config (key, value, updated_at)
      VALUES ('kite_access_token', 'db-token-1234', CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `,
    ).run();

    const token = resolveKiteAccessToken(db, 'env-token-9999');
    expect(token).toBe('db-token-1234');
  });

  it('falls back to env token when DB token missing or blank', () => {
    const tokenWhenMissing = resolveKiteAccessToken(db, 'env-token-1111');
    expect(tokenWhenMissing).toBe('env-token-1111');

    db.prepare(
      `
      INSERT INTO config (key, value, updated_at)
      VALUES ('kite_access_token', '   ', CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `,
    ).run();

    const tokenWhenBlank = resolveKiteAccessToken(db, 'env-token-2222');
    expect(tokenWhenBlank).toBe('env-token-2222');
  });

  it('returns empty string when neither DB nor env has token', () => {
    const token = resolveKiteAccessToken(db, undefined);
    expect(token).toBe('');
  });
});

