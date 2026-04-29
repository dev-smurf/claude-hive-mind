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
import type { Request, Response } from 'express';
import type { z } from 'zod';
import type { AgentRegistry } from '../services/agent-registry.js';
import type { FileOwnershipService } from '../services/file-ownership.js';
import type { TaskQueue } from '../services/task-queue.js';
import type { KnowledgeStore } from '../services/knowledge-store.js';
import type { DecisionLog } from '../services/decision-log.js';
import type { ConflictDetector } from '../services/conflict-detector.js';
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
} from '../schemas.js';
import type { TaskId } from '../types.js';
import { InvalidPathError } from '../util/path-normalize.js';
import { requireAgentMatch } from './middleware.js';

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
  const result = schema.safeParse(req.body);
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
 * Wrap a sync route handler so InvalidPathError becomes 400 instead of 500.
 * Other thrown errors propagate to the global error handler.
 */
function safe(handler: (req: Request, res: Response) => void) {
  return (req: Request, res: Response): void => {
    try {
      handler(req, res);
    } catch (err) {
      if (err instanceof InvalidPathError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// Snapshot cache for /api/state — short TTL to absorb dashboard polling.
// ---------------------------------------------------------------------------

const STATE_CACHE_TTL_MS = 1_000;

interface StateCache {
  generatedAt: number;
  body: string;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createRoutes(services: RouteServices): Router {
  const router = Router();
  const { registry, fileOwnership, taskQueue, knowledge, decisions, conflicts } = services;

  let stateCache: StateCache | null = null;

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------

  router.post('/api/agents/register', (req: Request, res: Response) => {
    const body = parseBody(req, res, registerAgentBodySchema);
    if (!body) return;

    const result = registry.register({
      displayName: body.displayName,
      tool: body.tool,
      workspacePath: body.workspacePath,
      ...(body.currentBranch !== undefined ? { currentBranch: body.currentBranch } : {}),
      ...(body.repoUrl !== undefined ? { repoUrl: body.repoUrl } : {}),
    });

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

  router.get('/api/agents', (_req: Request, res: Response) => {
    res.json(registry.getConnectedAgents());
  });

  router.get('/api/agents/:id', (req: Request, res: Response) => {
    const agent = registry.getAgent(agentId(param(req, 'id')));
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.json(agent);
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

  router.delete(
    '/api/files/{*path}',
    safe((req, res) => {
      const aid = queryParam(req, 'agentId');
      if (!aid) {
        res.status(400).json({ error: 'Missing query parameter: agentId' });
        return;
      }
      if (!requireAgentMatch(req, res, aid)) return;

      const ok = fileOwnership.release(param(req, 'path'), agentId(aid));
      if (!ok) {
        res.status(404).json({ error: 'File not claimed by this agent' });
        return;
      }
      res.json({ ok: true });
    }),
  );

  router.get('/api/files', (_req: Request, res: Response) => {
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
    const task = taskQueue.unassign(taskId(param(req, 'id')));
    if (!task) {
      res.status(409).json({ error: 'Cannot unassign task (not in_progress)' });
      return;
    }
    res.json(task);
  });

  router.post('/api/tasks/:id/complete', (req: Request, res: Response) => {
    const task = taskQueue.complete(taskId(param(req, 'id')));
    if (!task) {
      res.status(409).json({ error: 'Cannot complete task (not in_progress)' });
      return;
    }
    res.json(task);
  });

  router.post('/api/tasks/:id/fail', (req: Request, res: Response) => {
    const task = taskQueue.fail(taskId(param(req, 'id')));
    if (!task) {
      res.status(409).json({ error: 'Cannot fail task (not in_progress)' });
      return;
    }
    res.json(task);
  });

  router.post('/api/tasks/:id/cancel', (req: Request, res: Response) => {
    const task = taskQueue.cancel(taskId(param(req, 'id')));
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
    const ok = knowledge.delete(param(req, 'key'));
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
    const ok = conflicts.resolve(conflictId(param(req, 'id')));
    if (!ok) {
      res.status(404).json({ error: 'Conflict not found or already resolved' });
      return;
    }
    res.json({ ok: true });
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

  router.get('/api/state', (_req: Request, res: Response) => {
    const now = Date.now();
    if (stateCache && now - stateCache.generatedAt < STATE_CACHE_TTL_MS) {
      res.type('application/json').send(stateCache.body);
      return;
    }

    const body = JSON.stringify({
      agents: registry.getAllAgents(),
      fileOwnerships: fileOwnership.getAllOwnerships(),
      tasks: taskQueue.getAllTasks(),
      knowledge: knowledge.getAll(),
      decisions: decisions.getAll(),
      conflicts: conflicts.getAll(),
    });
    stateCache = { generatedAt: now, body };
    res.type('application/json').send(body);
  });

  return router;
}
