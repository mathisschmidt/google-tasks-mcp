import process from "node:process";
import { openKv } from "@deno/kv";
import { Context, Next } from "hono";

let kv: Awaited<ReturnType<typeof openKv>> | null = null;

export async function initRateLimiter() {
  kv = await openKv();
}

/**
 * Returns the client IP used as the rate-limit key.
 *
 * By default the socket address provided by the runtime is used (on Deno /
 * Deno Deploy, Hono exposes it as `c.env.remoteAddr`). Client-supplied headers
 * such as X-Forwarded-For are only trusted when TRUST_PROXY_HEADERS=true, i.e.
 * when the server runs behind a reverse proxy that overwrites them — otherwise
 * anyone could bypass the limit by sending a different header on each request.
 */
function getClientIp(c: Context): string {
  if (process.env.TRUST_PROXY_HEADERS === "true") {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    const realIp = c.req.header("x-real-ip")?.trim();
    if (forwarded) return forwarded;
    if (realIp) return realIp;
  }

  const env = c.env as { remoteAddr?: { hostname?: string } } | undefined;
  return env?.remoteAddr?.hostname || "unknown";
}

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

export function rateLimit(config: RateLimitConfig) {
  return async (c: Context, next: Next) => {
    if (!kv) {
      await next();
      return;
    }

    const ip = getClientIp(c);
    const key = ["rate_limit", c.req.path, ip];

    const now = Date.now();

    const entry = await kv.get<{ count: number; resetAt: number }>(key);

    if (entry.value) {
      if (entry.value.resetAt > now) {
        if (entry.value.count >= config.maxRequests) {
          return c.json(
            {
              error: "rate_limit_exceeded",
              error_description: "Too many requests. Please try again later.",
            },
            429
          );
        }

        await kv.set(
          key,
          {
            count: entry.value.count + 1,
            resetAt: entry.value.resetAt,
          },
          { expireIn: config.windowMs }
        );
      } else {
        await kv.set(
          key,
          {
            count: 1,
            resetAt: now + config.windowMs,
          },
          { expireIn: config.windowMs }
        );
      }
    } else {
      await kv.set(
        key,
        {
          count: 1,
          resetAt: now + config.windowMs,
        },
        { expireIn: config.windowMs }
      );
    }

    await next();
  };
}
