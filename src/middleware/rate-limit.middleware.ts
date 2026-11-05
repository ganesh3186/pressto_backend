import {HttpErrors, Middleware, Request} from '@loopback/rest';
import * as jwt from 'jsonwebtoken';

/**
 * The one place API rate limits are applied. It is registered once in
 * application.ts, so every route gets it, including ones added later.
 *
 * Limits are per minute. Counters live in each worker's memory, because the
 * server has no shared store. PM2 shares requests evenly between workers, so
 * each worker enforces its share of the configured limit and the total stays
 * close to it. Replacing FixedWindowCounter is all a shared store would need.
 */

export type RateLimitMode = 'off' | 'report' | 'enforce';
export type RateLimitTier = 'auth' | 'files' | 'user' | 'anonymous';

export interface RateLimitConfig {
  /** `report` logs what would be blocked and blocks nothing. */
  mode: RateLimitMode;
  /** Requests per minute, across all workers. */
  limits: Record<RateLimitTier, number>;
  workers: number;
  jwtSecret?: string;
}

const WINDOW_MS = 60000;
const DEFAULT_LIMITS: Record<RateLimitTier, number> = {
  // Per IP. Generous because a whole store can share one IP at shift start.
  auth: 60,
  // Per IP. Public image GETs: one table page can load many of them.
  files: 3000,
  // Per user, however many tabs or devices they have open.
  user: 600,
  // Per IP. Anything else without a valid token.
  anonymous: 300,
};

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function rateLimitConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RateLimitConfig {
  const mode = env.RATE_LIMIT_MODE;
  return {
    // Report-only until a deployment has confirmed these limits and that each
    // client gets its own IP behind the proxy.
    mode: mode === 'off' || mode === 'enforce' ? mode : 'report',
    limits: {
      auth: positiveInt(env.RATE_LIMIT_AUTH_PER_MIN, DEFAULT_LIMITS.auth),
      files: positiveInt(env.RATE_LIMIT_FILES_PER_MIN, DEFAULT_LIMITS.files),
      user: positiveInt(env.RATE_LIMIT_USER_PER_MIN, DEFAULT_LIMITS.user),
      anonymous: positiveInt(
        env.RATE_LIMIT_ANONYMOUS_PER_MIN,
        DEFAULT_LIMITS.anonymous,
      ),
    },
    // ecosystem.config.js runs 2 workers. PM2 sets NODE_APP_INSTANCE on each.
    workers:
      env.NODE_APP_INSTANCE === undefined
        ? 1
        : positiveInt(env.RATE_LIMIT_WORKERS ?? env.PM2_INSTANCES, 2),
    jwtSecret: env.JWT_SECRET,
  };
}

export class FixedWindowCounter {
  private readonly windows = new Map<string, {count: number; resetAt: number}>();
  private nextSweepAt = 0;

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one request and returns the count so far in this window. */
  hit(key: string): {count: number; resetAt: number} {
    const now = this.now();
    if (now >= this.nextSweepAt) {
      for (const [windowKey, {resetAt}] of this.windows) {
        if (resetAt <= now) this.windows.delete(windowKey);
      }
      this.nextSweepAt = now + this.windowMs;
    }

    let current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      current = {count: 0, resetAt: now + this.windowMs};
      this.windows.set(key, current);
    }
    current.count += 1;
    return current;
  }

  get size(): number {
    return this.windows.size;
  }
}

/** Groups an IPv6 client by its /64, which one customer can usually rotate within. */
export function clientIpKey(ip: string | undefined): string {
  const address = (ip ?? 'unknown').replace(/^::ffff:/, '');
  return address.includes(':') ? address.split(':').slice(0, 4).join(':') : address;
}

function userIdFromToken(
  request: Request,
  secret: string | undefined,
): string | undefined {
  const header = request.headers.authorization;
  if (!secret || !header?.startsWith('Bearer ')) return undefined;
  try {
    // Verified, not just decoded: otherwise a forged id per request would get a
    // fresh limit every time.
    const payload = jwt.verify(header.slice('Bearer '.length), secret);
    const id = typeof payload === 'object' ? payload.id : undefined;
    return typeof id === 'string' && id ? id : undefined;
  } catch {
    return undefined;
  }
}

export function classifyRequest(
  request: Request,
  jwtSecret: string | undefined,
): {tier: RateLimitTier; key: string} | null {
  const {method, path} = request;
  // Preflights carry no token. Health checks and payment webhooks must always
  // get through: Razorpay retrying a blocked webhook would only delay payments.
  if (method === 'OPTIONS' || path === '/ping' || path.startsWith('/webhooks/')) {
    return null;
  }

  const ip = clientIpKey(request.ip);
  if (method === 'POST' && path.startsWith('/auth/')) {
    return {tier: 'auth', key: `auth:${ip}`};
  }
  if (method === 'GET' && path.startsWith('/files/file/')) {
    return {tier: 'files', key: `files:${ip}`};
  }

  const userId = userIdFromToken(request, jwtSecret);
  return userId
    ? {tier: 'user', key: `user:${userId}`}
    : {tier: 'anonymous', key: `anonymous:${ip}`};
}

export function createRateLimitMiddleware(
  config: RateLimitConfig,
  counter = new FixedWindowCounter(WINDOW_MS),
): Middleware {
  return async (context, next) => {
    if (config.mode === 'off') return next();

    const match = classifyRequest(context.request, config.jwtSecret);
    if (!match) return next();

    const limit = Math.max(1, Math.ceil(config.limits[match.tier] / config.workers));
    const {count, resetAt} = counter.hit(match.key);
    if (count <= limit) return next();

    // Once per client per window, so a flood can't also flood the log.
    if (count === limit + 1) {
      console.warn(
        `[RateLimit] ${new Date().toISOString()} ` +
          `${config.mode === 'enforce' ? 'blocked' : 'would block'} ${match.key} ` +
          `tier=${match.tier} limit=${limit}/min per worker ` +
          `${context.request.method} ${context.request.path}`,
      );
    }
    if (config.mode === 'report') return next();

    context.response.setHeader(
      'Retry-After',
      Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
    );
    throw new HttpErrors.TooManyRequests(
      'Too many requests. Please wait a moment and try again.',
    );
  };
}
