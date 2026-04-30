import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, insertNews, migrate } from '../../src/db/index.js';
import { enrichSentiment } from '../../src/enrichers/sentiment/enricher.js';
import { MockLlmProvider } from '../../src/llm/providers/mock.js';
import type { NewsItem } from '../../src/types/domain.js';

describe('sentiment enricher', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;
  let llm: MockLlmProvider;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-sentiment-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = dbPath;
    db = getDb({ path: dbPath });
    migrate(db);
    llm = new MockLlmProvider();
  });

  afterEach(() => {
    db.close();
    closeDb();
    try {
      rmSync(dbPath);
      rmSync(`${dbPath}-wal`);
      rmSync(`${dbPath}-shm`);
    } catch {
      /* best effort */
    }
  });

  it('scores unscored news headlines', async () => {
    const items: NewsItem[] = [
      {
        headline: 'Reliance Q4 beats Street estimates',
        source: 'ET Markets',
        url: 'https://example.com/1',
        publishedAt: new Date().toISOString(),
        symbol: 'RELIANCE',
      },
      {
        headline: 'TCS reports weak guidance',
        source: 'Moneycontrol',
        url: 'https://example.com/2',
        publishedAt: new Date().toISOString(),
        symbol: 'TCS',
      },
    ];
    insertNews(items, db);

    const result = await enrichSentiment({ unscoredOnly: true, batchSize: 10 }, db, llm);
    expect(result.scored).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.batches).toBe(1);

    const rows = db.prepare('SELECT headline, sentiment FROM news ORDER BY id').all() as Array<{
      headline: string;
      sentiment: number | null;
    }>;

    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.sentiment).not.toBeNull();
      expect(r.sentiment).toBeGreaterThanOrEqual(-1);
      expect(r.sentiment).toBeLessThanOrEqual(1);
    }
  });

  it('skips already-scored headlines when unscoredOnly=true', async () => {
    const item: NewsItem = {
      headline: 'Market closes flat',
      source: 'ET',
      url: 'https://example.com/scored',
      publishedAt: new Date().toISOString(),
      sentiment: 0.5,
    };
    insertNews([item], db);

    const result = await enrichSentiment({ unscoredOnly: true }, db, llm);
    expect(result.scored).toBe(0);
    expect(result.batches).toBe(0);
    expect(llm.calls).toHaveLength(0);
  });

  it('batches headlines correctly', async () => {
    const items: NewsItem[] = Array.from({ length: 5 }, (_, i) => ({
      headline: `News headline ${i}`,
      source: 'Test',
      url: `https://example.com/batch-${i}`,
      publishedAt: new Date().toISOString(),
    }));
    insertNews(items, db);

    const result = await enrichSentiment({ batchSize: 2, limit: 5 }, db, llm);
    expect(result.batches).toBe(3);
    expect(result.scored).toBe(5);
  });
});
