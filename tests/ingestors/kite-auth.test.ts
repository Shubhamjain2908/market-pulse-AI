import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractRequestToken, upsertEnvVar } from '../../src/ingestors/kite/auth.js';

describe('extractRequestToken', () => {
  it('parses request_token from a redirect URL', () => {
    expect(
      extractRequestToken(
        'https://127.0.0.1:3001/auth/callback?request_token=abc123XYZ&action=login',
      ),
    ).toBe('abc123XYZ');
  });

  it('accepts a bare alphanumeric token', () => {
    expect(extractRequestToken('abc123XYZ')).toBe('abc123XYZ');
  });

  it('returns null for empty or invalid input', () => {
    expect(extractRequestToken('')).toBeNull();
    expect(extractRequestToken('not-a-token')).toBeNull();
  });
});

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

  it('replaces every assignment line and appends the key at the end', () => {
    writeFileSync(
      path,
      'KITE_API_KEY=keykeykey\nKITE_ACCESS_TOKEN=oldoldold\n# trailing comment\n',
    );
    upsertEnvVar(path, 'KITE_ACCESS_TOKEN', 'newnewnew');
    expect(readFileSync(path, 'utf8')).toBe(
      'KITE_API_KEY=keykeykey\n# trailing comment\nKITE_ACCESS_TOKEN=newnewnew\n',
    );
  });

  it('removes duplicate key lines so only one value remains', () => {
    writeFileSync(path, 'KITE_ACCESS_TOKEN=first\nFOO=bar\nKITE_ACCESS_TOKEN=second\n');
    upsertEnvVar(path, 'KITE_ACCESS_TOKEN', 'third');
    expect(readFileSync(path, 'utf8')).toBe('FOO=bar\nKITE_ACCESS_TOKEN=third\n');
  });

  it('matches export-prefixed and spaced assignments', () => {
    writeFileSync(path, 'export  KITE_ACCESS_TOKEN  =oldtoken\nNEXT=1\n');
    upsertEnvVar(path, 'KITE_ACCESS_TOKEN', 'fresh');
    expect(readFileSync(path, 'utf8')).toBe('NEXT=1\nKITE_ACCESS_TOKEN=fresh\n');
  });

  it('handles a file without trailing newline', () => {
    writeFileSync(path, 'FOO=bar');
    upsertEnvVar(path, 'KITE_ACCESS_TOKEN', 'xyz');
    expect(readFileSync(path, 'utf8')).toBe('FOO=bar\nKITE_ACCESS_TOKEN=xyz\n');
  });
});
