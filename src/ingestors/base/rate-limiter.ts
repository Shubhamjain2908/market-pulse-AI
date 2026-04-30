/**
 * Tiny token-bucket rate limiter. Sized for our needs (single process, a
 * handful of buckets) - if we ever need cross-process coordination we'll
 * swap this for Bottleneck or similar.
 */

export interface RateLimiterOptions {
  /** Sustained requests per second. */
  requestsPerSecond: number;
  /** Max burst above the steady rate. Defaults to `requestsPerSecond`. */
  burst?: number;
}

export class RateLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillRate: number;
  private lastRefill: number;
  private readonly queue: Array<() => void> = [];

  constructor(opts: RateLimiterOptions) {
    if (opts.requestsPerSecond <= 0) {
      throw new Error('requestsPerSecond must be positive');
    }
    this.refillRate = opts.requestsPerSecond;
    this.capacity = opts.burst ?? opts.requestsPerSecond;
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const idx = this.queue.indexOf(release);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new Error('rate limiter wait aborted'));
      };
      const release = () => {
        signal?.removeEventListener('abort', onAbort);
        this.tokens -= 1;
        resolve();
      };
      this.queue.push(release);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.scheduleNext();
    });
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const refill = elapsed * this.refillRate;
    if (refill > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + refill);
      this.lastRefill = now;
    }
  }

  private scheduleNext(): void {
    if (this.queue.length === 0) return;
    const tokensNeeded = 1 - this.tokens;
    const waitMs = Math.max(0, Math.ceil((tokensNeeded / this.refillRate) * 1000));
    setTimeout(() => {
      this.refill();
      while (this.queue.length > 0 && this.tokens >= 1) {
        const release = this.queue.shift();
        release?.();
      }
      if (this.queue.length > 0) this.scheduleNext();
    }, waitMs);
  }
}
