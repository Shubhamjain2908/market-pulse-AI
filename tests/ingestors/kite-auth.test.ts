import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { upsertEnvVar } from '../../src/ingestors/kite/auth.js';

describe('upsertEnvVar', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mp-env-'));
    path = join(dir, '.env');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the file when absent', () => {
    upsertEnvVar(path, 'KITE_ACCESS_TOKEN', 'abc123');
    expect(readFileSync(path, 'utf8')).toBe('KITE_ACCESS_TOKEN=abc123\n');
  });

  it('appends a new key without disturbing existing lines', () => {
    writeFileSync(path, 'KITE_API_KEY=keykeykey\n# important comment\n');
    upsertEnvVar(path, 'KITE_ACCESS_TOKEN', 'abc123');
    expect(readFileSync(path, 'utf8')).toBe(
      'KITE_API_KEY=keykeykey\n# important comment\nKITE_ACCESS_TOKEN=abc123\n',
    );
  });

  it('replaces in place when the key is already present', () => {
    writeFileSync(
      path,
      'KITE_API_KEY=keykeykey\nKITE_ACCESS_TOKEN=oldoldold\n# trailing comment\n',
    );
    upsertEnvVar(path, 'KITE_ACCESS_TOKEN', 'newnewnew');
    expect(readFileSync(path, 'utf8')).toBe(
      'KITE_API_KEY=keykeykey\nKITE_ACCESS_TOKEN=newnewnew\n# trailing comment\n',
    );
  });

  it('handles a file without trailing newline', () => {
    writeFileSync(path, 'FOO=bar');
    upsertEnvVar(path, 'KITE_ACCESS_TOKEN', 'xyz');
    expect(readFileSync(path, 'utf8')).toBe('FOO=bar\nKITE_ACCESS_TOKEN=xyz\n');
  });
});
