/**
 * Express middleware for authentication, rate limiting, and error handling.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Config } from '../config.js';

/** Timing-safe string comparison to prevent side-channel leaks. */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ---------------------------------------------------------------------------
// Auth middleware — Bearer token validation
// ---------------------------------------------------------------------------

export function authMiddleware(config: Config): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!config.authEnabled) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = authHeader.slice(7);
    if (!safeCompare(token, config.authToken)) {
      res.status(403).json({ error: 'Invalid auth token' });
      return;
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Rate limiting — simple sliding window per IP
// ---------------------------------------------------------------------------

interface RateEntry {
  count: number;
  resetAt: number;
}

export function rateLimitMiddleware(config: Config): RequestHandler {
  const clients = new Map<string, RateEntry>();

  // Periodic cleanup of stale entries
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of clients) {
      if (entry.resetAt <= now) {
        clients.delete(ip);
      }
    }
  }, config.rateLimitWindowMs);
  cleanup.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();

    let entry = clients.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + config.rateLimitWindowMs };
      clients.set(ip, entry);
    }

    entry.count++;

    res.setHeader('X-RateLimit-Limit', String(config.rateLimitMaxRequests));
    res.setHeader(
      'X-RateLimit-Remaining',
      String(Math.max(0, config.rateLimitMaxRequests - entry.count)),
    );
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > config.rateLimitMaxRequests) {
      res.status(429).json({ error: 'Rate limit exceeded' });
      return;
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Error handler — catches unhandled errors in routes
// ---------------------------------------------------------------------------

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  console.error('[Server] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
}
