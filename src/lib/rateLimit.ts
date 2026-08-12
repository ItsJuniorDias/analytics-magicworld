/**
 * Minimal in-memory token-bucket rate limiter.
 *
 * One instance per key (typically the client IP). Fine for a single Render
 * dyno — if we ever horizontally scale, swap for Redis. Not worth the extra
 * dep at this stage.
 */

type Bucket = {
  tokens: number;
  lastRefillMs: number;
};

export class RateLimiter {
  private readonly perMinute: number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(perMinute: number) {
    this.perMinute = Math.max(1, perMinute);
  }

  /** Returns true if the request is allowed and consumes a token. */
  allow(key: string): boolean {
    const now = Date.now();
    const b = this.buckets.get(key) ?? {
      tokens: this.perMinute,
      lastRefillMs: now,
    };
    // Refill: tokens replenish linearly up to `perMinute` per minute.
    const elapsedMs = now - b.lastRefillMs;
    const refill = (elapsedMs / 60_000) * this.perMinute;
    b.tokens = Math.min(this.perMinute, b.tokens + refill);
    b.lastRefillMs = now;

    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }

  /** Periodically evict cold buckets so the map doesn't grow forever. */
  gc(maxAgeMs = 15 * 60_000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [key, b] of this.buckets) {
      if (b.lastRefillMs < cutoff) this.buckets.delete(key);
    }
  }
}
