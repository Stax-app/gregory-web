/**
 * GREGORY — Rate Limiter
 *
 * Simple in-memory sliding window rate limiter for Edge Functions.
 * Tracks request counts per user/IP within a time window.
 *
 * Note: In-memory state resets between Edge Function cold starts.
 * This provides best-effort protection, not absolute guarantees.
 * For strict rate limiting, use a persistent store (Redis/KV).
 */

interface RateLimitEntry {
  timestamps: number[];
}

const store: Map<string, RateLimitEntry> = new Map();

// Clean up old entries periodically
let lastCleanup = Date.now();
const CLEANUP_INTERVAL = 60000; // 1 minute

// Use the largest window for cleanup to avoid pruning long-window entries prematurely
const MAX_WINDOW_MS = 60 * 60 * 1000; // 1 hour (matches ORCHESTRATE_LIMIT / UPLOAD_LIMIT)

function cleanup() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;

  const cutoff = now - MAX_WINDOW_MS;
  for (const [key, entry] of store) {
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
    if (entry.timestamps.length === 0) {
      store.delete(key);
    }
  }
}

export interface RateLimitConfig {
  /** Maximum requests allowed in the window */
  maxRequests: number;
  /** Time window in milliseconds */
  windowMs: number;
  /** Key prefix to separate different limiters */
  prefix: string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  retryAfterSeconds?: number;
}

/**
 * Check if a request is allowed under the rate limit.
 */
export function checkRateLimit(
  identifier: string,
  config: RateLimitConfig,
): RateLimitResult {
  cleanup();

  const key = `${config.prefix}:${identifier}`;
  const now = Date.now();
  const cutoff = now - config.windowMs;

  let entry = store.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    store.set(key, entry);
  }

  // Remove expired timestamps
  entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

  if (entry.timestamps.length >= config.maxRequests) {
    // Rate limited
    const oldestInWindow = entry.timestamps[0];
    const resetMs = oldestInWindow + config.windowMs - now;
    return {
      allowed: false,
      remaining: 0,
      resetMs,
      retryAfterSeconds: Math.ceil(resetMs / 1000),
    };
  }

  // Allow and record
  entry.timestamps.push(now);

  return {
    allowed: true,
    remaining: config.maxRequests - entry.timestamps.length,
    resetMs: config.windowMs,
  };
}

/**
 * Extract a rate limit identifier from a request.
 * Uses user ID if authenticated, falls back to IP.
 */
export function getRateLimitKey(req: Request, userId?: string): string {
  if (userId && userId !== "anonymous") {
    return `user:${userId}`;
  }
  // Fall back to IP
  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded ? forwarded.split(",")[0].trim() : "unknown";
  return `ip:${ip}`;
}

/**
 * Create a 429 Too Many Requests response.
 */
export function rateLimitResponse(result: RateLimitResult): Response {
  return new Response(
    JSON.stringify({
      error: "Rate limit exceeded. Please slow down.",
      retry_after: result.retryAfterSeconds,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(result.retryAfterSeconds || 60),
        "X-RateLimit-Remaining": "0",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    },
  );
}

// ── Pre-configured limiters ──

export const CHAT_LIMIT: RateLimitConfig = {
  maxRequests: 30,
  windowMs: 60 * 1000, // 30 requests per minute
  prefix: "chat",
};

export const ORCHESTRATE_LIMIT: RateLimitConfig = {
  maxRequests: 5,
  windowMs: 60 * 60 * 1000, // 5 tasks per hour
  prefix: "orchestrate",
};

export const UPLOAD_LIMIT: RateLimitConfig = {
  maxRequests: 20,
  windowMs: 60 * 60 * 1000, // 20 uploads per hour
  prefix: "upload",
};
