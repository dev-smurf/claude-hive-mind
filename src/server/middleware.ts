/**
 * Express middleware for authentication, rate limiting, and error handling.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Config } from '../config.js';
import type { AgentRegistry } from '../services/agent-registry.js';
import type { InviteService } from '../services/invites.js';
import { logger } from '../util/logger.js';

/**
 * Constant-time string comparison that does not leak length.
 *
 * Both inputs are first hashed with SHA-256 to a fixed 32-byte digest, then
 * the digests are compared with `timingSafeEqual`. This eliminates the
 * length-mismatch oracle that a naive `length` early-return would expose.
 */
export function safeCompare(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------------------
// Auth context — attached to req when authenticated
// ---------------------------------------------------------------------------

/** Authentication mode for the current request. */
export type AuthMode = 'admin' | 'agent' | 'bootstrap' | 'anonymous';

/** Properties added to req by authMiddleware. */
export interface AuthContext {
  authMode: AuthMode;
  /** When authMode === 'agent', the ID of the authenticated agent. */
  authenticatedAgentId?: string;
  /** When authMode === 'bootstrap', the join_token row id. */
  joinTokenId?: string;
}

declare module 'express-serve-static-core' {
  // Augment Express's Request type with our auth fields.
  interface Request {
    auth?: AuthContext;
  }
}

// ---------------------------------------------------------------------------
// Auth middleware — Bearer token validation (admin OR per-agent)
// ---------------------------------------------------------------------------

/**
 * Authenticate the request via Bearer token.
 *
 * Two-tier model:
 *  - Admin token (CHM_AUTH_TOKEN): full access, all routes.
 *  - Per-agent token: scoped — agent-specific routes must match the
 *    authenticated agent. Used for routes like heartbeat, branch updates,
 *    or anything that mutates the agent's own state.
 *
 * Returns 401 if no/malformed header, 403 if token is invalid.
 */
export function authMiddleware(
  config: Config,
  registry: AgentRegistry,
  invites: InviteService,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!config.authEnabled) {
      // Auth disabled → grant admin so per-route checks pass through.
      req.auth = { authMode: 'admin' };
      next();
      return;
    }

    const authHeader = req.headers.authorization;

    // Anonymous-read mode: in 'open' policy, GET requests succeed without
    // a token. Writes still flow through the regular auth check below.
    // The token (if present) takes precedence — readers can still
    // authenticate to get richer data (e.g. unsanitized fields for admin).
    if (config.readAccess === 'open' && req.method === 'GET' && !authHeader) {
      req.auth = { authMode: 'anonymous' };
      next();
      return;
    }

    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = authHeader.slice(7);

    // First check: admin token grants full access. safeCompare hashes both
    // inputs to a fixed-length digest, so length is never leaked.
    if (safeCompare(token, config.authToken)) {
      req.auth = { authMode: 'admin' };
      next();
      return;
    }

    // Second check: per-agent token.
    const agent = registry.getAgentByToken(token);
    if (agent) {
      req.auth = { authMode: 'agent', authenticatedAgentId: agent.id };
      next();
      return;
    }

    // Third check: bootstrap (join) token — only allowed on routes that
    // explicitly opt in via `requireBootstrap` / `requireBootstrapOrAdmin`.
    const joinToken = invites.validateJoinToken(token);
    if (joinToken) {
      req.auth = { authMode: 'bootstrap', joinTokenId: joinToken.id };
      next();
      return;
    }

    res.status(403).json({ error: 'Invalid auth token' });
  };
}

/**
 * Helper for route handlers: ensure the authenticated caller is allowed to
 * act on `agentIdParam`. Admin can act on anyone; agent tokens can only
 * act on themselves.
 *
 * Returns true if authorized; otherwise sends 403 and returns false.
 */
export function requireAgentMatch(req: Request, res: Response, agentIdParam: string): boolean {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return false;
  }
  if (auth.authMode === 'admin') return true;
  if (auth.authMode === 'agent' && auth.authenticatedAgentId === agentIdParam) {
    return true;
  }
  // Differentiate between "wrong token type" and "wrong agent".
  if (auth.authMode === 'bootstrap') {
    res
      .status(403)
      .json({ error: 'Bootstrap (join) tokens cannot mutate agent state — register first' });
    return false;
  }
  res.status(403).json({
    error: 'Agent token does not match the agent in this request',
    authenticatedAgentId: auth.authenticatedAgentId,
    requestedAgentId: agentIdParam,
  });
  return false;
}

/**
 * Like `requireAgentMatch` but accepts a nullable owner. When the owner is
 * null (resource has no assigned agent), only admin tokens may act.
 *
 * Used for routes that mutate resources owned by a specific agent: task
 * complete/fail/unassign/cancel, knowledge delete, conflict resolve.
 */
export function requireOwnerOrAdmin(
  req: Request,
  res: Response,
  ownerAgentId: string | null,
): boolean {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return false;
  }
  if (auth.authMode === 'admin') return true;
  if (ownerAgentId !== null && auth.authenticatedAgentId === ownerAgentId) {
    return true;
  }
  res.status(403).json({
    error:
      ownerAgentId === null
        ? 'Resource has no owner — admin token required'
        : 'Only the resource owner or admin can perform this action',
    ownerAgentId,
    yourAgentId: auth.authenticatedAgentId ?? null,
  });
  return false;
}

/** Allow only admin tokens. Used for destructive cross-cutting operations. */
export function requireAdmin(req: Request, res: Response): boolean {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return false;
  }
  if (auth.authMode === 'admin') return true;
  res.status(403).json({ error: 'Admin token required' });
  return false;
}

/** True iff the request is authenticated as admin (not a per-agent token). */
export function isAdmin(req: Request): boolean {
  return req.auth?.authMode === 'admin';
}

/**
 * Allow either admin OR a bootstrap (join) token. Used by `register` so a
 * peer with a join token can register a fresh agent for their session.
 */
export function requireBootstrapOrAdmin(req: Request, res: Response): boolean {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return false;
  }
  if (auth.authMode === 'admin' || auth.authMode === 'bootstrap') return true;
  res.status(403).json({ error: 'Admin or join token required' });
  return false;
}

/**
 * Allow admin OR an agent token. Used by `create invite` so peers can
 * generate invites for their teammates.
 */
export function requireAuthAgent(req: Request, res: Response): boolean {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return false;
  }
  if (auth.authMode === 'admin' || auth.authMode === 'agent') return true;
  res.status(403).json({ error: 'Token does not authorize this operation' });
  return false;
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
    // req.ip honours `app.set('trust proxy', ...)` configured in server.ts.
    // Without trust proxy, this is the socket address (loopback when behind a
    // reverse proxy) — see config.trustProxy.
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

/**
 * Aggressive per-IP rate limiter for the unauthenticated invite-redeem
 * endpoint. The global limiter (200/min) is too loose for a brute-force
 * target — at 200/min an attacker could try 12k codes/hour against the
 * 8-char alphabet. We cap at 10 attempts / 5 minutes / IP, which still
 * leaves real onboarding fast (the user types the code once).
 */
export function strictRedeemRateLimit(): RequestHandler {
  const WINDOW_MS = 5 * 60 * 1000;
  const MAX = 10;
  const clients = new Map<string, RateEntry>();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of clients) {
      if (entry.resetAt <= now) clients.delete(ip);
    }
  }, WINDOW_MS);
  cleanup.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    let entry = clients.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + WINDOW_MS };
      clients.set(ip, entry);
    }
    entry.count++;
    if (entry.count > MAX) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      res.status(429).json({ error: 'Too many invite redemption attempts' });
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
  logger.error('http', 'Unhandled error in route', {
    error: err instanceof Error ? err.message : String(err),
  });
  res.status(500).json({ error: 'Internal server error' });
}
