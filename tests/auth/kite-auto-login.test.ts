import { describe, expect, it } from 'vitest';
import { kiteAccessTokenRefreshed } from '../../src/auth/kite-auto-login/login.js';

describe('kiteAccessTokenRefreshed', () => {
  const prior = { token: 'abc123', updatedAt: '2026-06-27 08:00:00' };

  it('detects a new token value', () => {
    expect(kiteAccessTokenRefreshed(prior, { token: 'xyz789', updatedAt: prior.updatedAt })).toBe(
      true,
    );
  });

  it('detects same token with refreshed updated_at', () => {
    expect(
      kiteAccessTokenRefreshed(prior, { token: prior.token, updatedAt: '2026-06-27 09:50:00' }),
    ).toBe(true);
  });

  it('rejects unchanged snapshot', () => {
    expect(kiteAccessTokenRefreshed(prior, prior)).toBe(false);
  });

  it('rejects empty current token', () => {
    expect(kiteAccessTokenRefreshed(prior, { token: '', updatedAt: null })).toBe(false);
  });
});
