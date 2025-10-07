// Simple in-memory token bucket rate limiter (per-process). Suitable for single instance or dev.
// Keys are arbitrary (e.g., `login:ip:1.2.3.4` or `login:user:userid`).
// For multi-instance deployment, replace backing store with Redis or durable KV.

interface Bucket {
  tokens: number
  updatedAt: number
}

const buckets = new Map<string, Bucket>()

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  limit: number
  retryAfterMs?: number
}

export interface RateLimitOptions {
  capacity: number // max tokens
  refillPerSec: number // tokens added per second (fractional allowed)
  cost?: number // tokens consumed per call (default 1)
  now?: number // inject time for tests
}

export function rateLimit(key: string, opts: RateLimitOptions): RateLimitResult {
  const now = opts.now ?? Date.now()
  const cost = opts.cost ?? 1
  let b = buckets.get(key)
  if (!b) {
    b = { tokens: opts.capacity, updatedAt: now }
    buckets.set(key, b)
  }
  // Refill
  const elapsedSec = (now - b.updatedAt) / 1000
  if (elapsedSec > 0) {
    b.tokens = Math.min(opts.capacity, b.tokens + elapsedSec * opts.refillPerSec)
    b.updatedAt = now
  }
  if (b.tokens >= cost) {
    b.tokens -= cost
    return { allowed: true, remaining: Math.floor(b.tokens), limit: opts.capacity }
  }
  const needed = cost - b.tokens
  const retryAfterSec = needed / opts.refillPerSec
  return {
    allowed: false,
    remaining: 0,
    limit: opts.capacity,
    retryAfterMs: Math.ceil(retryAfterSec * 1000),
  }
}

export function resetRateLimitForTests() { buckets.clear() }
