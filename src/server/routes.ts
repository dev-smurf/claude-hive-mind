/**
 * HTTP REST API routes.
 *
 * All domain operations are exposed as JSON endpoints.
 * The MCP tools and dashboard call these same endpoints.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AgentRegistry } from '../services/agent-registry.js';
import type { FileOwnershipService } from '../services/file-ownership.js';
import type { TaskQueue } from '../services/task-queue.js';
import type { KnowledgeStore } from '../services/knowledge-store.js';
import type { DecisionLog } from '../services/decision-log.js';
import type { ConflictDetector } from '../services/conflict-detector.js';
import { agentId, taskId, conflictId } from '../schemas.js';
import type { AgentTool, DecisionCategory, OwnershipMode, TaskId, TaskPriority } from '../types.js';

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
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/** Safely extract a query param as a string. */
function queryParam(req: Request, name: string): string | undefined {
  const v = req.query[name];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createRoutes(services: RouteServices): Router {
  const router = Router();
  const { registry, fileOwnership, taskQueue, knowledge, decisions, conflicts } = services;

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------

  router.post('/api/agents/register', (req: Request, res: Response) => {
    const { displayName, tool, workspacePath } = req.body as {
      displayName?: string;
      tool?: string;
      workspacePath?: string;
    };

    if (!displayName || !tool || !workspacePath) {
      res.status(400).json({ error: 'Missing required fields: displayName, tool, workspacePath' });
      return;
    }

    const agent = registry.register({
      displayName,
      tool: tool as AgentTool,
      workspacePath,
    });

    res.status(201).json(agent);
  });

  router.post('/api/agents/:id/heartbeat', (req: Request, res: Response) => {
    const ok = registry.heartbeat(agentId(param(req, 'id')));
    if (!ok) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.json({ ok: true });
  });

  router.delete('/api/agents/:id', (req: Request, res: Response) => {
    const ok = registry.disconnect(agentId(param(req, 'id')));
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

  router.post('/api/files/claim', (req: Request, res: Response) => {
    const {
      filePath,
      agentId: aid,
      mode,
      taskId: tid,
      ttlMs,
    } = req.body as {
      filePath?: string;
      agentId?: string;
      mode?: string;
      taskId?: string;
      ttlMs?: number | null;
    };

    if (!filePath || !aid || !mode) {
      res.status(400).json({ error: 'Missing required fields: filePath, agentId, mode' });
      return;
    }

    const result = fileOwnership.claim({
      filePath,
      agentId: agentId(aid),
      mode: mode as OwnershipMode,
      taskId: tid ? taskId(tid) : null,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    });

    if (result.granted) {
      res.status(201).json(result);
    } else {
      res.status(409).json(result);
    }
  });

  router.delete('/api/files/:path(*)', (req: Request, res: Response) => {
    const aid = queryParam(req, 'agentId');
    if (!aid) {
      res.status(400).json({ error: 'Missing query parameter: agentId' });
      return;
    }

    const ok = fileOwnership.release(param(req, 'path'), agentId(aid));
    if (!ok) {
      res.status(404).json({ error: 'File not claimed by this agent' });
      return;
    }
    res.json({ ok: true });
  });

  router.get('/api/files', (_req: Request, res: Response) => {
    res.json(fileOwnership.getAllOwnerships());
  });

  router.get('/api/files/check/:path(*)', (req: Request, res: Response) => {
    const ownership = fileOwnership.getOwnership(param(req, 'path'));
    if (ownership) {
      res.json(ownership);
    } else {
      res.json({ available: true, filePath: param(req, 'path') });
    }
  });

  router.get('/api/files/agent/:id', (req: Request, res: Response) => {
    res.json(fileOwnership.getFilesByAgent(agentId(param(req, 'id'))));
  });

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  router.post('/api/tasks', (req: Request, res: Response) => {
    const { title, description, priority, filePaths, dependsOn } = req.body as {
      title?: string;
      description?: string;
      priority?: string;
      filePaths?: string[];
      dependsOn?: string[];
    };

    if (!title || description === undefined) {
      res.status(400).json({ error: 'Missing required fields: title, description' });
      return;
    }

    const deps = dependsOn?.map((id) => taskId(id)) as readonly TaskId[] | undefined;

    const task = taskQueue.create({
      title,
      description,
      ...(priority !== undefined ? { priority: priority as TaskPriority } : {}),
      ...(filePaths !== undefined ? { filePaths } : {}),
      ...(deps !== undefined ? { dependsOn: deps } : {}),
    });

    res.status(201).json(task);
  });

  router.post('/api/tasks/:id/assign', (req: Request, res: Response) => {
    const { agentId: aid } = req.body as { agentId?: string };
    if (!aid) {
      res.status(400).json({ error: 'Missing required field: agentId' });
      return;
    }

    const task = taskQueue.assign(taskId(param(req, 'id')), agentId(aid));
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
    const {
      key,
      value,
      agentId: aid,
      sourceHash,
      ttlSeconds,
    } = req.body as {
      key?: string;
      value?: string;
      agentId?: string;
      sourceHash?: string | null;
      ttlSeconds?: number | null;
    };

    if (!key || !value || !aid) {
      res.status(400).json({ error: 'Missing required fields: key, value, agentId' });
      return;
    }

    const entry = knowledge.share({
      key,
      value,
      agentId: agentId(aid),
      ...(sourceHash !== undefined ? { sourceHash } : {}),
      ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
    });

    res.status(201).json(entry);
  });

  router.get('/api/knowledge', (_req: Request, res: Response) => {
    res.json(knowledge.getAll());
  });

  router.get('/api/knowledge/:key(*)', (req: Request, res: Response) => {
    const entry = knowledge.get(param(req, 'key'));
    if (!entry) {
      res.status(404).json({ error: 'Knowledge entry not found' });
      return;
    }
    res.json(entry);
  });

  router.delete('/api/knowledge/:key(*)', (req: Request, res: Response) => {
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
    const {
      agentId: aid,
      category,
      summary,
      rationale,
    } = req.body as {
      agentId?: string;
      category?: string;
      summary?: string;
      rationale?: string;
    };

    if (!aid || !category || !summary || !rationale) {
      res.status(400).json({
        error: 'Missing required fields: agentId, category, summary, rationale',
      });
      return;
    }

    const decision = decisions.log({
      agentId: agentId(aid),
      category: category as DecisionCategory,
      summary,
      rationale,
    });

    res.status(201).json(decision);
  });

  router.get('/api/decisions', (req: Request, res: Response) => {
    const category = queryParam(req, 'category');
    if (category) {
      res.json(decisions.getByCategory(category as DecisionCategory));
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
    res.json({
      agents: registry.getAllAgents(),
      fileOwnerships: fileOwnership.getAllOwnerships(),
      tasks: taskQueue.getAllTasks(),
      knowledge: knowledge.getAll(),
      decisions: decisions.getAll(),
      conflicts: conflicts.getAll(),
    });
  });

  // -------------------------------------------------------------------------
  // Health check (no auth required — registered before auth middleware)
  // -------------------------------------------------------------------------

  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', version: '0.1.0' });
  });

  return router;
}
