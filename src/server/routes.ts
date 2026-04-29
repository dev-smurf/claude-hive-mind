/**
 * HTTP REST API routes.
 *
 * All domain operations are exposed as JSON endpoints.
 * The MCP tools and dashboard call these same endpoints.
 *
 * Boundary discipline: every body is parsed through a Zod schema.
 * Routes that mutate a specific agent enforce per-agent token auth
 * via `requireAgentMatch`.
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { z } from 'zod';
import type { AgentRegistry } from '../services/agent-registry.js';
import type { FileOwnershipService } from '../services/file-ownership.js';
import type { TaskQueue } from '../services/task-queue.js';
import type { KnowledgeStore } from '../services/knowledge-store.js';
import type { DecisionLog } from '../services/decision-log.js';
import type { ConflictDetector } from '../services/conflict-detector.js';
import {
  InviteNotRedeemableError,
  InviteQuotaExceededError,
  type InviteService,
  normalizeInviteCode,
} from '../services/invites.js';
import type { MessageService } from '../services/messages.js';
import type { Store } from '../services/store.js';
import type { EventBus } from '../services/event-bus.js';
import type { ISOTimestamp } from '../types.js';
import {
  agentId,
  taskId,
  conflictId,
  registerAgentBodySchema,
  updateBranchBodySchema,
  claimFileBodySchema,
  createTaskBodySchema,
  assignTaskBodySchema,
  shareKnowledgeBodySchema,
  logDecisionBodySchema,
  sendMessageBodySchema,
  gitStatusBodySchema,
  runStatusBodySchema,
} from '../schemas.js';
import type { AgentRecord, TaskId } from '../types.js';
import { InvalidPathError } from '../util/path-normalize.js';
import {
  isAdmin,
  requireAdmin,
  requireAgentMatch,
  requireAuthAgent,
  requireBootstrapOrAdmin,
  requireOwnerOrAdmin,
} from './middleware.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RouteServices {
  readonly registry: AgentRegistry;
  readonly fileOwnership: FileOwnershipService;
  readonly taskQueue: TaskQueue;
  readonly knowledge: KnowledgeStore;
  readonly decisions: DecisionLog;
  readonly conflicts: ConflictDetector;
  readonly invites: InviteService;
  readonly messages: MessageService;
  /** Used directly for agent_metadata read/write (no service wrapper needed). */
  readonly store: Store;
  /** Bus to publish agent_status_update events for git/run status. */
  readonly bus: EventBus;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safely extract a route param as a string. */
function param(req: Request, name: string): string {
  const v = req.params[name];
  if (Array.isArray(v)) return v.join('/');
  return v ?? '';
}

/** Safely extract a query param as a string. */
function queryParam(req: Request, name: string): string | undefined {
  const v = req.query[name];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

/**
 * Parse request body through a Zod schema. On failure, send 400 with
 * the validation error message and return null. Caller checks for null.
 */
function parseBody<T>(req: Request, res: Response, schema: z.ZodType<T>): T | null {
  // Reject non-object bodies up front so the Zod error message is
  // precise instead of complaining about every required field.
  const raw = req.body as unknown;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    res.status(400).json({
      error: 'Invalid request body',
      details: 'Body must be a JSON object',
    });
    return null;
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    res.status(400).json({
      error: 'Invalid request body',
      details: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
    return null;
  }
  return result.data;
}

/**
 * Wrap a route handler (sync or async) so InvalidPathError becomes 400
 * instead of 500. All other errors are forwarded to Express's `next` so
 * the global `errorHandler` runs (and the client never hangs on an
 * unhandled async rejection).
 */
function safe(handler: (req: Request, res: Response) => void | Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const r = handler(req, res);
      if (r && typeof r === 'object' && 'catch' in r) {
        r.catch((err: unknown) => {
          if (err instanceof InvalidPathError) {
            res.status(400).json({ error: err.message });
            return;
          }
          next(err);
        });
      }
    } catch (err) {
      if (err instanceof InvalidPathError) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  };
}

/** Public-facing fields that admin tokens see but agent tokens do not. */
type PublicAgent = Omit<AgentRecord, 'workspacePath' | 'repoUrl'>;

/**
 * Strip workspace_path and repo_url from an agent record when the caller is
 * not an admin. Agents do not need each other's filesystem layout.
 */
function sanitizeAgent(req: Request, agent: AgentRecord): AgentRecord | PublicAgent {
  if (isAdmin(req)) return agent;
  // Agent can see its own full record.
  if (req.auth?.authenticatedAgentId === agent.id) return agent;
  const { workspacePath: _w, repoUrl: _r, ...rest } = agent;
  return rest;
}

// ---------------------------------------------------------------------------
// Snapshot cache for /api/state — short TTL to absorb dashboard polling.
// ---------------------------------------------------------------------------

const STATE_CACHE_TTL_MS = 1_000;
/** Max distinct auth contexts to remember in the state cache. Bounds memory. */
const STATE_CACHE_MAX_ENTRIES = 256;

interface StateCache {
  generatedAt: number;
  body: string;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createRoutes(services: RouteServices): Router {
  const router = Router();
  const {
    registry,
    fileOwnership,
    taskQueue,
    knowledge,
    decisions,
    conflicts,
    invites,
    messages,
    store,
    bus,
  } = services;

  // Per-auth-context cache so admin-only data never leaks to agent tokens.
  const stateCache = new Map<string, StateCache>();

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------

  router.post('/api/agents/register', (req: Request, res: Response) => {
    // Register accepts admin OR a bootstrap (join) token. Per-agent tokens
    // cannot register new agents — that would be self-replication.
    if (!requireBootstrapOrAdmin(req, res)) return;

    const body = parseBody(req, res, registerAgentBodySchema);
    if (!body) return;

    const result = registry.register({
      displayName: body.displayName,
      tool: body.tool,
      workspacePath: body.workspacePath,
      ...(body.currentBranch !== undefined ? { currentBranch: body.currentBranch } : {}),
      ...(body.repoUrl !== undefined ? { repoUrl: body.repoUrl } : {}),
    });

    // Track that a join token was used to register an agent (for audit).
    if (req.auth?.authMode === 'bootstrap' && req.auth.joinTokenId) {
      invites.recordJoinTokenUse(req.auth.joinTokenId);
    }

    // The agent token is returned only here — the client must capture it
    // and use it for subsequent requests via the Authorization header.
    res.status(201).json(result);
  });

  router.post('/api/agents/:id/heartbeat', (req: Request, res: Response) => {
    const id = param(req, 'id');
    if (!requireAgentMatch(req, res, id)) return;

    const ok = registry.heartbeat(agentId(id));
    if (!ok) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.json({ ok: true });
  });

  router.post('/api/agents/:id/branch', (req: Request, res: Response) => {
    const id = param(req, 'id');
    if (!requireAgentMatch(req, res, id)) return;

    const body = parseBody(req, res, updateBranchBodySchema);
    if (!body) return;

    const ok = registry.updateBranch(agentId(id), body.branch);
    if (!ok) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.json({ ok: true });
  });

  router.delete('/api/agents/:id', (req: Request, res: Response) => {
    const id = param(req, 'id');
    if (!requireAgentMatch(req, res, id)) return;

    const ok = registry.disconnect(agentId(id));
    if (!ok) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.json({ ok: true });
  });

  /**
   * Rotate an agent's bearer token. The caller proves ownership via the
   * existing token (or admin), the server mints a new one and the old one
   * stops working immediately. Useful when a token is suspected leaked or
   * after a long session.
   */
  router.post('/api/agents/:id/rotate-token', (req: Request, res: Response) => {
    const id = param(req, 'id');
    if (!requireAgentMatch(req, res, id)) return;

    const newToken = registry.rotateToken(agentId(id));
    if (!newToken) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.json({ agentId: id, agentToken: newToken });
  });

  router.get('/api/agents', (req: Request, res: Response) => {
    const agents = registry.getConnectedAgents();
    res.json(agents.map((a) => sanitizeAgent(req, a)));
  });

  router.get('/api/agents/:id', (req: Request, res: Response) => {
    const agent = registry.getAgent(agentId(param(req, 'id')));
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.json(sanitizeAgent(req, agent));
  });

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  router.post(
    '/api/files/claim',
    safe((req, res) => {
      const body = parseBody(req, res, claimFileBodySchema);
      if (!body) return;
      if (!requireAgentMatch(req, res, body.agentId)) return;

      const result = fileOwnership.claim({
        filePath: body.filePath,
        agentId: agentId(body.agentId),
        mode: body.mode,
        taskId: body.taskId !== undefined && body.taskId !== null ? taskId(body.taskId) : null,
        ...(body.ttlMs !== undefined ? { ttlMs: body.ttlMs } : {}),
        ...(body.branch !== undefined ? { branch: body.branch } : {}),
      });

      if (result.granted) {
        res.status(201).json(result);
      } else {
        res.status(409).json(result);
      }
    }),
  );

  /**
   * Block `DELETE /api/files/claim` BEFORE the wildcard route so the
   * common mistake (mirroring `POST /api/files/claim`) returns a clear
   * hint instead of pretending to release a file literally named "claim".
   * Also blocks `DELETE /api/files` (no path).
   */
  router.delete('/api/files/claim', (_req: Request, res: Response) => {
    res.status(400).json({
      error:
        'To release a file, the path goes in the URL: DELETE /api/files/<file-path>?agentId=<id>',
      hint: 'Example: DELETE /api/files/src%2Findex.ts?agentId=abc',
    });
  });

  // Friendly hints for the other URL shapes agents tend to invent.
  router.post('/api/files/release', (_req: Request, res: Response) => {
    res.status(400).json({
      error: 'No POST /api/files/release endpoint',
      hint: 'Use DELETE /api/files/<file-path>?agentId=<id> to release a claim',
    });
  });

  router.delete('/api/files', (_req: Request, res: Response) => {
    res.status(400).json({
      error: 'Missing file path. Use DELETE /api/files/<file-path>?agentId=<id>',
    });
  });

  router.delete(
    '/api/files/{*path}',
    safe((req, res) => {
      const aid = queryParam(req, 'agentId');
      if (!aid) {
        res.status(400).json({ error: 'Missing query parameter: agentId' });
        return;
      }
      if (!requireAgentMatch(req, res, aid)) return;

      const result = fileOwnership.release(param(req, 'path'), agentId(aid));
      if (result.released) {
        res.json({ ok: true });
        return;
      }
      // Distinguish the 3 failure modes so callers can react appropriately
      // (e.g. retry vs. give up vs. wait for the other agent to release).
      const messages: Record<string, string> = {
        'no-claim-exists': 'No claim exists on this file',
        'held-by-other-agent': 'File is claimed by a different agent',
        'no-matching-claim': 'You no longer hold a claim on this file (expired or reaped)',
      };
      const reason = result.reason ?? 'no-matching-claim';
      res.status(404).json({
        error: messages[reason] ?? 'File not claimed by this agent',
        reason,
      });
    }),
  );

  router.get('/api/files', (req: Request, res: Response) => {
    const aid = queryParam(req, 'agentId');
    if (aid) {
      res.json(fileOwnership.getFilesByAgent(agentId(aid)));
      return;
    }
    res.json(fileOwnership.getAllOwnerships());
  });

  router.get(
    '/api/files/check/{*path}',
    safe((req, res) => {
      const ownership = fileOwnership.getOwnership(param(req, 'path'));
      if (ownership) {
        res.json(ownership);
      } else {
        res.json({ available: true, filePath: param(req, 'path') });
      }
    }),
  );

  router.get('/api/files/agent/:id', (req: Request, res: Response) => {
    res.json(fileOwnership.getFilesByAgent(agentId(param(req, 'id'))));
  });

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  router.post('/api/tasks', (req: Request, res: Response) => {
    const body = parseBody(req, res, createTaskBodySchema);
    if (!body) return;

    const deps = body.dependsOn?.map((id) => taskId(id)) as readonly TaskId[] | undefined;

    const task = taskQueue.create({
      title: body.title,
      description: body.description,
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.filePaths !== undefined ? { filePaths: body.filePaths } : {}),
      ...(deps !== undefined ? { dependsOn: deps } : {}),
    });

    res.status(201).json(task);
  });

  router.post('/api/tasks/:id/assign', (req: Request, res: Response) => {
    const body = parseBody(req, res, assignTaskBodySchema);
    if (!body) return;
    if (!requireAgentMatch(req, res, body.agentId)) return;

    const task = taskQueue.assign(taskId(param(req, 'id')), agentId(body.agentId));
    if (!task) {
      res.status(409).json({ error: 'Cannot assign task (not pending or dependencies unmet)' });
      return;
    }
    res.json(task);
  });

  router.post('/api/tasks/:id/unassign', (req: Request, res: Response) => {
    const tid = taskId(param(req, 'id'));
    const existing = taskQueue.getTask(tid);
    if (!existing) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (!requireOwnerOrAdmin(req, res, existing.assignedAgentId)) return;

    const task = taskQueue.unassign(tid);
    if (!task) {
      res.status(409).json({ error: 'Cannot unassign task (not in_progress)' });
      return;
    }
    res.json(task);
  });

  router.post('/api/tasks/:id/complete', (req: Request, res: Response) => {
    const tid = taskId(param(req, 'id'));
    const existing = taskQueue.getTask(tid);
    if (!existing) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (!requireOwnerOrAdmin(req, res, existing.assignedAgentId)) return;

    const task = taskQueue.complete(tid);
    if (!task) {
      res.status(409).json({ error: 'Cannot complete task (not in_progress)' });
      return;
    }
    res.json(task);
  });

  router.post('/api/tasks/:id/fail', (req: Request, res: Response) => {
    const tid = taskId(param(req, 'id'));
    const existing = taskQueue.getTask(tid);
    if (!existing) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (!requireOwnerOrAdmin(req, res, existing.assignedAgentId)) return;

    const task = taskQueue.fail(tid);
    if (!task) {
      res.status(409).json({ error: 'Cannot fail task (not in_progress)' });
      return;
    }
    res.json(task);
  });

  router.post('/api/tasks/:id/cancel', (req: Request, res: Response) => {
    const tid = taskId(param(req, 'id'));
    const existing = taskQueue.getTask(tid);
    if (!existing) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    // Cancellation is allowed by the assigned agent OR by an admin.
    if (!requireOwnerOrAdmin(req, res, existing.assignedAgentId)) return;

    const task = taskQueue.cancel(tid);
    if (!task) {
      res.status(409).json({ error: 'Cannot cancel task' });
      return;
    }
    res.json(task);
  });

  router.get('/api/tasks', (_req: Request, res: Response) => {
    res.json(taskQueue.getAllTasks());
  });

  router.get('/api/tasks/next', (_req: Request, res: Response) => {
    const task = taskQueue.getNextAvailable();
    if (!task) {
      res.status(204).end();
      return;
    }
    res.json(task);
  });

  router.get('/api/tasks/:id', (req: Request, res: Response) => {
    const task = taskQueue.getTask(taskId(param(req, 'id')));
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json(task);
  });

  router.delete('/api/tasks/:id', (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const ok = taskQueue.delete(taskId(param(req, 'id')));
    if (!ok) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Knowledge
  // -------------------------------------------------------------------------

  router.post('/api/knowledge', (req: Request, res: Response) => {
    const body = parseBody(req, res, shareKnowledgeBodySchema);
    if (!body) return;
    if (!requireAgentMatch(req, res, body.agentId)) return;

    const entry = knowledge.share({
      key: body.key,
      value: body.value,
      agentId: agentId(body.agentId),
      ...(body.sourceHash !== undefined ? { sourceHash: body.sourceHash } : {}),
      ...(body.ttlSeconds !== undefined ? { ttlSeconds: body.ttlSeconds } : {}),
    });

    res.status(201).json(entry);
  });

  router.get('/api/knowledge', (_req: Request, res: Response) => {
    res.json(knowledge.getAll());
  });

  router.get('/api/knowledge/{*key}', (req: Request, res: Response) => {
    const entry = knowledge.get(param(req, 'key'));
    if (!entry) {
      res.status(404).json({ error: 'Knowledge entry not found' });
      return;
    }
    res.json(entry);
  });

  router.delete('/api/knowledge/{*key}', (req: Request, res: Response) => {
    const key = param(req, 'key');
    const existing = knowledge.get(key);
    if (!existing) {
      res.status(404).json({ error: 'Knowledge entry not found' });
      return;
    }
    if (!requireOwnerOrAdmin(req, res, existing.agentId)) return;

    const ok = knowledge.delete(key);
    if (!ok) {
      res.status(404).json({ error: 'Knowledge entry not found' });
      return;
    }
    res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------

  router.post('/api/decisions', (req: Request, res: Response) => {
    const body = parseBody(req, res, logDecisionBodySchema);
    if (!body) return;
    if (!requireAgentMatch(req, res, body.agentId)) return;

    const decision = decisions.log({
      agentId: agentId(body.agentId),
      category: body.category,
      summary: body.summary,
      rationale: body.rationale,
    });

    res.status(201).json(decision);
  });

  router.get('/api/decisions', (req: Request, res: Response) => {
    const category = queryParam(req, 'category');
    if (category) {
      // Validated through the schema's enum — invalid categories yield empty.
      res.json(decisions.getAll().filter((d) => d.category === category));
    } else {
      res.json(decisions.getAll());
    }
  });

  // -------------------------------------------------------------------------
  // Conflicts
  // -------------------------------------------------------------------------

  router.get('/api/conflicts', (req: Request, res: Response) => {
    const unresolved = queryParam(req, 'unresolved') === 'true';
    res.json(unresolved ? conflicts.getUnresolved() : conflicts.getAll());
  });

  router.post('/api/conflicts/:id/resolve', (req: Request, res: Response) => {
    const cid = conflictId(param(req, 'id'));
    const existing = conflicts.get(cid);
    if (!existing) {
      res.status(404).json({ error: 'Conflict not found' });
      return;
    }
    // Either party of the conflict, or an admin, may resolve it.
    const auth = req.auth;
    const callerIsParty =
      auth?.authMode === 'agent' &&
      (auth.authenticatedAgentId === existing.agentA ||
        auth.authenticatedAgentId === existing.agentB);
    if (!isAdmin(req) && !callerIsParty) {
      res.status(403).json({ error: 'Token does not authorize this operation' });
      return;
    }

    const ok = conflicts.resolve(cid);
    if (!ok) {
      res.status(409).json({ error: 'Conflict already resolved' });
      return;
    }
    res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Invites — onboarding flow
  // -------------------------------------------------------------------------

  /** Anyone authenticated (admin OR agent) can mint an invite. */
  router.post('/api/invites', (req: Request, res: Response) => {
    if (!requireAuthAgent(req, res)) return;

    // Defensive read — body may be null, a primitive, or an array.
    const rawBody = req.body as unknown;
    const body =
      rawBody !== null && typeof rawBody === 'object' && !Array.isArray(rawBody)
        ? (rawBody as { label?: unknown; ttlMs?: unknown })
        : {};
    const label = typeof body.label === 'string' ? body.label.slice(0, 200) : undefined;
    const ttlMs = typeof body.ttlMs === 'number' && body.ttlMs > 0 ? body.ttlMs : undefined;

    const auth = req.auth;
    const createdBy = auth?.authMode === 'admin' ? 'admin' : (auth?.authenticatedAgentId ?? '');
    if (!createdBy) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    try {
      const result = invites.create({
        createdBy,
        ...(label !== undefined ? { label } : {}),
        ...(ttlMs !== undefined ? { ttlMs } : {}),
      });
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof InviteQuotaExceededError) {
        res.status(429).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  /**
   * Redeem an invite. NO AUTH REQUIRED — that's the point: a fresh peer
   * with only the code can claim a join token. Heavy rate-limit applied
   * via the global rateLimitMiddleware. Single-use; expires fast.
   */
  router.post('/api/invites/redeem', (req: Request, res: Response) => {
    const rawBody = req.body as unknown;
    const body =
      rawBody !== null && typeof rawBody === 'object' && !Array.isArray(rawBody)
        ? (rawBody as { code?: unknown })
        : {};
    const rawCode = typeof body.code === 'string' ? body.code : '';
    const code = normalizeInviteCode(rawCode);
    if (!code) {
      res.status(400).json({ error: 'Invalid code format' });
      return;
    }

    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    try {
      const result = invites.redeem({ code, remoteIp: ip });
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof InviteNotRedeemableError) {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  /** List invites visible to caller (admin: all; agent: own). */
  router.get('/api/invites', (req: Request, res: Response) => {
    if (!requireAuthAgent(req, res)) return;
    const scope = isAdmin(req) ? 'admin' : (req.auth?.authenticatedAgentId ?? '');
    res.json(invites.list(scope));
  });

  /** Revoke an invite. Admin: any; agent: own. */
  router.delete('/api/invites/:code', (req: Request, res: Response) => {
    if (!requireAuthAgent(req, res)) return;
    const code = normalizeInviteCode(param(req, 'code'));
    if (!code) {
      res.status(400).json({ error: 'Invalid code format' });
      return;
    }
    const scope = isAdmin(req) ? 'admin' : (req.auth?.authenticatedAgentId ?? '');
    const ok = invites.revoke(code, scope);
    if (!ok) {
      res.status(404).json({ error: 'Invite not found or not yours' });
      return;
    }
    res.json({ ok: true });
  });

  /** Admin-only: list all join tokens (for audit / revocation UI). */
  router.get('/api/join-tokens', (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    res.json(invites.listJoinTokens());
  });

  /** Admin-only: revoke a join token by id. */
  router.delete('/api/join-tokens/:id', (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const id = param(req, 'id');
    const ok = invites.revokeJoinToken(id);
    if (!ok) {
      res.status(404).json({ error: 'Join token not found' });
      return;
    }
    res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Messages — agent-to-agent coordination signals (NOT commands)
  // -------------------------------------------------------------------------

  /**
   * Send a message. Recipient `toAgentId` can be null to broadcast.
   * Sender is derived from the auth token (admin uses an explicit fromAgentId).
   */
  router.post('/api/messages', (req: Request, res: Response) => {
    if (!requireAuthAgent(req, res)) return;
    const body = parseBody(req, res, sendMessageBodySchema);
    if (!body) return;

    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    // Sender = the authenticated agent (admin can't send "as" without an id).
    if (auth.authMode === 'admin') {
      // Admin needs to specify a sender (we don't pretend admin is an agent).
      const adminFrom = (req.body as { fromAgentId?: unknown }).fromAgentId;
      if (typeof adminFrom !== 'string') {
        res.status(400).json({ error: 'Admin senders must include an explicit `fromAgentId`' });
        return;
      }
      const fromAgent = registry.getAgent(agentId(adminFrom));
      if (!fromAgent) {
        res.status(404).json({ error: 'fromAgentId does not match any registered agent' });
        return;
      }
      const msg = messages.send({
        fromAgentId: agentId(adminFrom),
        toAgentId: body.toAgentId !== null ? agentId(body.toAgentId) : null,
        content: body.content,
      });
      res.status(201).json(msg);
      return;
    }

    const fromId = auth.authenticatedAgentId;
    if (!fromId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const msg = messages.send({
      fromAgentId: agentId(fromId),
      toAgentId: body.toAgentId !== null ? agentId(body.toAgentId) : null,
      content: body.content,
    });
    res.status(201).json(msg);
  });

  /**
   * List messages visible to the caller. Admin sees all; agents see
   * broadcasts + DMs to/from themselves.
   *
   * Query: `?since=<iso>` returns only newer messages, `?limit=<n>` caps
   * the result count (default 100, max 500).
   */
  router.get('/api/messages', (req: Request, res: Response) => {
    if (!requireAuthAgent(req, res)) return;
    const since = queryParam(req, 'since') ?? null;
    const limitRaw = queryParam(req, 'limit');
    const limit = limitRaw ? Math.min(500, Math.max(1, parseInt(limitRaw, 10) || 100)) : 100;

    if (isAdmin(req)) {
      res.json(messages.getAll({ since, limit }));
      return;
    }
    const aid = req.auth?.authenticatedAgentId;
    if (!aid) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    res.json(messages.getForAgent(agentId(aid), { since, limit }));
  });

  /** Sender (or admin) can delete a message they sent. */
  router.delete('/api/messages/:id', (req: Request, res: Response) => {
    if (!requireAuthAgent(req, res)) return;
    const msgId = param(req, 'id');
    const existing = messages.get(msgId);
    if (!existing) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }
    if (!requireOwnerOrAdmin(req, res, existing.fromAgentId)) return;
    messages.delete(msgId);
    res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Agent metadata — git status, run status (test/build), etc.
  // -------------------------------------------------------------------------

  /**
   * An agent shares its current git status. Pure FYI — other agents read
   * this to know if they should pull, what branch you're on, whether you
   * have uncommitted changes.
   */
  router.post('/api/agents/:id/git-status', (req: Request, res: Response) => {
    const id = param(req, 'id');
    if (!requireAgentMatch(req, res, id)) return;
    const body = parseBody(req, res, gitStatusBodySchema);
    if (!body) return;

    const value = JSON.stringify(body);
    store.upsertAgentMetadata(agentId(id), 'git', value);
    bus.emit({
      type: 'agent_status_update',
      agentId: agentId(id),
      key: 'git',
      value,
      updatedAt: new Date().toISOString() as ISOTimestamp,
    });
    res.json({ ok: true });
  });

  /**
   * An agent shares the result of running tests/build/lint/typecheck.
   * Other agents see "Felix's tests are green" without having to ask.
   */
  router.post('/api/agents/:id/run-status', (req: Request, res: Response) => {
    const id = param(req, 'id');
    if (!requireAgentMatch(req, res, id)) return;
    const body = parseBody(req, res, runStatusBodySchema);
    if (!body) return;

    const value = JSON.stringify({ ...body, at: new Date().toISOString() });
    store.upsertAgentMetadata(agentId(id), `run:${body.command}`, value);
    bus.emit({
      type: 'agent_status_update',
      agentId: agentId(id),
      key: `run:${body.command}`,
      value,
      updatedAt: new Date().toISOString() as ISOTimestamp,
    });
    res.json({ ok: true });
  });

  /** Read all metadata an agent has published. */
  router.get('/api/agents/:id/metadata', (req: Request, res: Response) => {
    const id = param(req, 'id');
    res.json(store.getAgentMetadata(agentId(id)));
  });

  // -------------------------------------------------------------------------
  // Activity feed — chronological history of recent hive events
  // -------------------------------------------------------------------------

  /**
   * Returns recent hive activity in chronological order: file claims/releases,
   * decisions, knowledge, conflicts, messages, run statuses. Useful as the
   * "what just happened" feed in the dashboard.
   *
   * Query: `?since=<iso>`, `?limit=<n>` (default 50, max 200).
   */
  router.get('/api/activity', (req: Request, res: Response) => {
    // Open to anonymous readers — DMs in the feed are still scoped to
    // the caller (anonymous sees only broadcasts, agents see their own).
    const since = queryParam(req, 'since') ?? null;
    const limitRaw = queryParam(req, 'limit');
    const limit = limitRaw ? Math.min(200, Math.max(1, parseInt(limitRaw, 10) || 50)) : 50;
    const sinceTs = since ? Date.parse(since) : 0;

    interface ActivityItem {
      type: string;
      at: string;
      payload: unknown;
    }
    const items: ActivityItem[] = [];

    // File ownership claims (we have claimedAt)
    for (const f of fileOwnership.getAllOwnerships()) {
      if (Date.parse(f.claimedAt) > sinceTs) {
        items.push({ type: 'file_claimed', at: f.claimedAt, payload: f });
      }
    }
    // Tasks (created/updated)
    for (const t of taskQueue.getAllTasks()) {
      if (Date.parse(t.createdAt) > sinceTs) {
        items.push({ type: 'task_created', at: t.createdAt, payload: t });
      }
      if (Date.parse(t.updatedAt) > sinceTs && t.updatedAt !== t.createdAt) {
        items.push({ type: 'task_updated', at: t.updatedAt, payload: t });
      }
    }
    // Decisions
    for (const d of decisions.getAll()) {
      if (Date.parse(d.timestamp) > sinceTs) {
        items.push({ type: 'decision_logged', at: d.timestamp, payload: d });
      }
    }
    // Knowledge
    for (const k of knowledge.getAll()) {
      if (Date.parse(k.createdAt) > sinceTs) {
        items.push({ type: 'knowledge_shared', at: k.createdAt, payload: k });
      }
    }
    // Conflicts
    for (const c of conflicts.getAll()) {
      if (Date.parse(c.detectedAt) > sinceTs) {
        items.push({ type: 'conflict_detected', at: c.detectedAt, payload: c });
      }
    }
    // Messages (only those visible to the caller)
    const aid = req.auth?.authenticatedAgentId;
    const visibleMessages = isAdmin(req)
      ? messages.getAll({ since, limit: 200 })
      : aid
        ? messages.getForAgent(agentId(aid), { since, limit: 200 })
        : [];
    for (const m of visibleMessages) {
      items.push({ type: 'message_received', at: m.createdAt, payload: m });
    }

    // Sort newest-first and cap
    items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    res.json(items.slice(0, limit));
  });

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  router.get('/api/status', (_req: Request, res: Response) => {
    const agents = registry.getConnectedAgents();
    const files = fileOwnership.getAllOwnerships();
    const unresolvedConflicts = conflicts.getUnresolved();

    res.json({
      connectedAgents: agents.length,
      claimedFiles: files.length,
      unresolvedConflicts: unresolvedConflicts.length,
      agents: agents.map((a) => ({
        id: a.id,
        displayName: a.displayName,
        tool: a.tool,
        status: a.status,
      })),
    });
  });

  router.get('/api/state', (req: Request, res: Response) => {
    // Cache is per-context: admin gets full data, agents get sanitized data.
    // The cache is keyed by 'admin' or the authenticated agent ID.
    const auth = req.auth;
    // Prefixed key namespace prevents an agent UUID equal to "admin" from
    // colliding with the admin bucket.
    const cacheKey: string = isAdmin(req)
      ? 'admin:'
      : `agent:${auth?.authenticatedAgentId ?? 'anonymous'}`;
    const now = Date.now();
    const cached = stateCache.get(cacheKey);
    if (cached && now - cached.generatedAt < STATE_CACHE_TTL_MS) {
      res.type('application/json').send(cached.body);
      return;
    }

    const body = JSON.stringify({
      agents: registry.getAllAgents().map((a) => sanitizeAgent(req, a)),
      fileOwnerships: fileOwnership.getAllOwnerships(),
      tasks: taskQueue.getAllTasks(),
      knowledge: knowledge.getAll(),
      decisions: decisions.getAll(),
      conflicts: conflicts.getAll(),
    });

    // Bound the cache: drop the oldest entry once we hit the cap.
    if (stateCache.size >= STATE_CACHE_MAX_ENTRIES) {
      const oldest = stateCache.keys().next().value;
      if (oldest !== undefined) stateCache.delete(oldest);
    }
    stateCache.set(cacheKey, { generatedAt: now, body });
    res.type('application/json').send(body);
  });

  return router;
}
