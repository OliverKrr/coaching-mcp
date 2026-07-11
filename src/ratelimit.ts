import type { IncomingMessage } from "node:http";

/**
 * Fixed-window in-memory rate limiter for the auth endpoints — defense in
 * depth behind whatever the reverse proxy/CDN already enforces. Per client IP:
 * CF-Connecting-IP (CDN-provided real client) wins over X-Real-IP (often the
 * CDN edge when nginx sits behind one) wins over the first X-Forwarded-For
 * entry wins over the socket address.
 */

export function clientIp(req: IncomingMessage): string {
  for (const header of ["cf-connecting-ip", "x-real-ip"]) {
    const value = req.headers[header];
    if (typeof value === "string" && value) return value;
  }
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return (fwd.split(",")[0] as string).trim();
  return req.socket.remoteAddress ?? "unknown";
}

export class RateLimiter {
  private buckets = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private max = 30,
    private windowMs = 5 * 60 * 1000,
  ) {}

  configure(max: number, windowMs = this.windowMs): void {
    this.max = max;
    this.windowMs = windowMs;
  }

  /** Returns true when the request is allowed. */
  allow(req: IncomingMessage, now = Date.now()): boolean {
    return this.allowKey(clientIp(req), now);
  }

  /** Same fixed window, arbitrary key — e.g. a user id for per-user budgets. */
  allowKey(key: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      // opportunistic cleanup so the map cannot grow unbounded
      if (this.buckets.size > 10_000) {
        for (const [k, b] of this.buckets) {
          if (now - b.windowStart >= this.windowMs) this.buckets.delete(k);
        }
      }
      this.buckets.set(key, { windowStart: now, count: 1 });
      return true;
    }
    bucket.count++;
    return bucket.count <= this.max;
  }

  reset(): void {
    this.buckets.clear();
  }
}

/** The instance guarding /authorize, /token, /register, /oidc/callback. */
export const authRateLimiter = new RateLimiter();
