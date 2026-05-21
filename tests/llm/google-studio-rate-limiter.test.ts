import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlidingWindowRateLimiter } from '../../src/llm/providers/google-studio.js';

describe('SlidingWindowRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('queues the 16th Gemini call until the 60s window resets', async () => {
    const limiter = new SlidingWindowRateLimiter(15, 60_000);
    await Promise.all(Array.from({ length: 15 }, () => limiter.acquire()));

    let released = false;
    const extra = limiter.acquire().then(() => {
      released = true;
    });

    await vi.advanceTimersByTimeAsync(59_999);
    await Promise.resolve();
    expect(released).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await extra;
    expect(released).toBe(true);
  });
});
