/**
 * Integration tests for the HTTP REST API routes.
 *
 * Spins up a full server (Express + services) and tests every endpoint
 * with real HTTP requests. Uses an in-memory SQLite DB so tests are fast
 * and isolated.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { HiveMindServer } from '../../src/server/server.js';
import { createHiveMindServer } from '../../src/server/server.js';
import type { Config } from '../../src/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0, // OS assigns a free port
    host: '127.0.0.1',
    dbPath: ':memory:',
    authToken: 'test-token',
    authEnabled: false, // Simplify tests — auth tested separately
    corsOrigins: ['*'],
    rateLimitWindowMs: 60_000,
    rateLimitMaxRequests: 1000,
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
    staleAgentCleanupMs: 60_000,
    defaultClaimTtlMs: 300_000,
    maxClaimsPerAgent: 50,
    defaultKnowledgeTtlSeconds: 3600,
    maxKnowledgeEntries: 1000,
    wsMaxPayloadBytes: 1_048_576,
    wsPingIntervalMs: 15_000,
    dashboardEnabled: false,
    nodeEnv: 'test',
    logLevel: 'error',
    ...overrides,
  };
}

function baseUrl(server: HiveMindServer): string {
  const addr = server.httpServer.address();
  if (typeof addr === 'string' || !addr) throw new Error('Server not listening');
  return `http://127.0.0.1:${String(addr.port)}`;
}

async function post(url: string, body: Record<string, unknown>, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function get(url: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { method: 'GET', headers });
}

async function del(url: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { method: 'DELETE', headers });
}

interface AgentResponse {
  id: string;
  displayName: string;
  tool: string;
  status: string;
  workspacePath: string;
}

async function registerAgent(
  base: string,
  name = 'TestAgent',
  tool = 'claude-code',
): Promise<AgentResponse> {
  const res = await post(`${base}/api/agents/register`, {
    displayName: name,
    tool,
    workspacePath: '/test/workspace',
  });
  return res.json() as Promise<AgentResponse>;
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('HTTP API', () => {
  let server: HiveMindServer;
  let base: string;

  beforeEach(async () => {
    server = createHiveMindServer(testConfig());
    await server.start();
    base = baseUrl(server);
  });

  afterEach(async () => {
    await server.stop();
  });

  // -----------------------------------------------------------------------
  // Health
  // -----------------------------------------------------------------------

  describe('GET /health', () => {
    it('returns ok status', async () => {
      const res = await get(`${base}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; version: string };
      expect(body.status).toBe('ok');
      expect(body.version).toBe('0.1.0');
    });
  });

  // -----------------------------------------------------------------------
  // Agents
  // -----------------------------------------------------------------------

  describe('Agents', () => {
    it('registers an agent', async () => {
      const res = await post(`${base}/api/agents/register`, {
        displayName: 'Claude #1',
        tool: 'claude-code',
        workspacePath: '/home/user/project',
      });
      expect(res.status).toBe(201);
      const agent = (await res.json()) as AgentResponse;
      expect(agent.displayName).toBe('Claude #1');
      expect(agent.tool).toBe('claude-code');
      expect(agent.status).toBe('active');
      expect(agent.id).toBeTruthy();
    });

    it('rejects registration with missing fields', async () => {
      const res = await post(`${base}/api/agents/register`, { displayName: 'Incomplete' });
      expect(res.status).toBe(400);
    });

    it('sends heartbeat', async () => {
      const agent = await registerAgent(base);
      const res = await post(`${base}/api/agents/${agent.id}/heartbeat`, {});
      expect(res.status).toBe(200);
    });

    it('returns 404 for heartbeat of unknown agent', async () => {
      const res = await post(`${base}/api/agents/unknown-id/heartbeat`, {});
      expect(res.status).toBe(404);
    });

    it('disconnects an agent', async () => {
      const agent = await registerAgent(base);
      const res = await del(`${base}/api/agents/${agent.id}`);
      expect(res.status).toBe(200);

      // Verify disconnected
      const getRes = await get(`${base}/api/agents/${agent.id}`);
      const body = (await getRes.json()) as AgentResponse;
      expect(body.status).toBe('disconnected');
    });

    it('unassigns orphaned tasks on agent disconnect', async () => {
      const agent = await registerAgent(base);

      // Create and assign a task
      const createRes = await post(`${base}/api/tasks`, {
        title: 'Orphan test',
        description: 'Will be orphaned',
      });
      const task = (await createRes.json()) as { id: string };
      await post(`${base}/api/tasks/${task.id}/assign`, { agentId: agent.id });

      // Disconnect agent — task should return to pending
      await del(`${base}/api/agents/${agent.id}`);

      const taskRes = await get(`${base}/api/tasks/${task.id}`);
      const taskBody = (await taskRes.json()) as { status: string; assignedAgentId: string | null };
      expect(taskBody.status).toBe('pending');
      expect(taskBody.assignedAgentId).toBeNull();
    });

    it('lists connected agents', async () => {
      await registerAgent(base, 'Agent A');
      await registerAgent(base, 'Agent B');
      const res = await get(`${base}/api/agents`);
      expect(res.status).toBe(200);
      const agents = (await res.json()) as AgentResponse[];
      expect(agents).toHaveLength(2);
    });

    it('gets a specific agent', async () => {
      const agent = await registerAgent(base, 'Specific');
      const res = await get(`${base}/api/agents/${agent.id}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as AgentResponse;
      expect(body.displayName).toBe('Specific');
    });

    it('returns 404 for unknown agent', async () => {
      const res = await get(`${base}/api/agents/nonexistent`);
      expect(res.status).toBe(404);
    });

    it('registers agent with branch context', async () => {
      const res = await post(`${base}/api/agents/register`, {
        displayName: 'Branch Agent',
        tool: 'claude-code',
        workspacePath: '/home/user/project',
        currentBranch: 'feature/auth',
        repoUrl: 'https://github.com/dev-smurf/project.git',
      });
      expect(res.status).toBe(201);
      const agent = (await res.json()) as AgentResponse & {
        currentBranch: string | null;
        repoUrl: string | null;
      };
      expect(agent.currentBranch).toBe('feature/auth');
      expect(agent.repoUrl).toBe('https://github.com/dev-smurf/project.git');
    });

    it('updates agent branch', async () => {
      const agent = await registerAgent(base);
      const res = await post(`${base}/api/agents/${agent.id}/branch`, {
        branch: 'feature/new',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);

      // Verify via GET
      const getRes = await get(`${base}/api/agents/${agent.id}`);
      const updated = (await getRes.json()) as AgentResponse & { currentBranch: string | null };
      expect(updated.currentBranch).toBe('feature/new');
    });

    it('returns 404 for branch update of unknown agent', async () => {
      const res = await post(`${base}/api/agents/nonexistent/branch`, {
        branch: 'main',
      });
      expect(res.status).toBe(404);
    });

    it('rejects branch update without branch field', async () => {
      const agent = await registerAgent(base);
      const res = await post(`${base}/api/agents/${agent.id}/branch`, {});
      expect(res.status).toBe(400);
    });

    it('allows setting branch to null', async () => {
      const res = await post(`${base}/api/agents/register`, {
        displayName: 'Null Branch',
        tool: 'cursor',
        workspacePath: '/test',
        currentBranch: 'main',
      });
      const agent = (await res.json()) as AgentResponse;

      const updateRes = await post(`${base}/api/agents/${agent.id}/branch`, {
        branch: null,
      });
      expect(updateRes.status).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // Files
  // -----------------------------------------------------------------------

  describe('Files', () => {
    let agentA: AgentResponse;
    let agentB: AgentResponse;

    beforeEach(async () => {
      agentA = await registerAgent(base, 'Agent A');
      agentB = await registerAgent(base, 'Agent B');
    });

    it('claims a file in exclusive mode', async () => {
      const res = await post(`${base}/api/files/claim`, {
        filePath: 'src/index.ts',
        agentId: agentA.id,
        mode: 'exclusive',
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { granted: boolean };
      expect(body.granted).toBe(true);
    });

    it('rejects conflicting exclusive claim', async () => {
      await post(`${base}/api/files/claim`, {
        filePath: 'src/index.ts',
        agentId: agentA.id,
        mode: 'exclusive',
      });

      const res = await post(`${base}/api/files/claim`, {
        filePath: 'src/index.ts',
        agentId: agentB.id,
        mode: 'exclusive',
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { granted: boolean };
      expect(body.granted).toBe(false);
    });

    it('allows shared claims from multiple agents', async () => {
      const r1 = await post(`${base}/api/files/claim`, {
        filePath: 'src/config.ts',
        agentId: agentA.id,
        mode: 'shared',
      });
      expect(r1.status).toBe(201);

      const r2 = await post(`${base}/api/files/claim`, {
        filePath: 'src/config.ts',
        agentId: agentB.id,
        mode: 'shared',
      });
      expect(r2.status).toBe(201);
    });

    it('releases a file', async () => {
      await post(`${base}/api/files/claim`, {
        filePath: 'src/main.ts',
        agentId: agentA.id,
        mode: 'exclusive',
      });

      const res = await del(`${base}/api/files/src/main.ts?agentId=${agentA.id}`);
      expect(res.status).toBe(200);
    });

    it('rejects release without agentId', async () => {
      const res = await del(`${base}/api/files/src/main.ts`);
      expect(res.status).toBe(400);
    });

    it('lists all file ownerships', async () => {
      await post(`${base}/api/files/claim`, {
        filePath: 'a.ts',
        agentId: agentA.id,
        mode: 'exclusive',
      });
      await post(`${base}/api/files/claim`, {
        filePath: 'b.ts',
        agentId: agentB.id,
        mode: 'shared',
      });

      const res = await get(`${base}/api/files`);
      expect(res.status).toBe(200);
      const files = (await res.json()) as unknown[];
      expect(files).toHaveLength(2);
    });

    it('lists files by agent', async () => {
      await post(`${base}/api/files/claim`, {
        filePath: 'x.ts',
        agentId: agentA.id,
        mode: 'exclusive',
      });
      await post(`${base}/api/files/claim`, {
        filePath: 'y.ts',
        agentId: agentA.id,
        mode: 'exclusive',
      });
      await post(`${base}/api/files/claim`, {
        filePath: 'z.ts',
        agentId: agentB.id,
        mode: 'exclusive',
      });

      const res = await get(`${base}/api/files/agent/${agentA.id}`);
      expect(res.status).toBe(200);
      const files = (await res.json()) as unknown[];
      expect(files).toHaveLength(2);
    });

    it('rejects claim with missing fields', async () => {
      const res = await post(`${base}/api/files/claim`, { filePath: 'src/x.ts' });
      expect(res.status).toBe(400);
    });

    it('allows same file claimed exclusively on different branches', async () => {
      const r1 = await post(`${base}/api/files/claim`, {
        filePath: 'src/shared.ts',
        agentId: agentA.id,
        mode: 'exclusive',
        branch: 'main',
      });
      expect(r1.status).toBe(201);

      const r2 = await post(`${base}/api/files/claim`, {
        filePath: 'src/shared.ts',
        agentId: agentB.id,
        mode: 'exclusive',
        branch: 'feature/auth',
      });
      expect(r2.status).toBe(201);
      const body = (await r2.json()) as { granted: boolean };
      expect(body.granted).toBe(true);
    });

    it('detects conflict for same file on same branch', async () => {
      await post(`${base}/api/files/claim`, {
        filePath: 'src/conflict.ts',
        agentId: agentA.id,
        mode: 'exclusive',
        branch: 'main',
      });

      const r2 = await post(`${base}/api/files/claim`, {
        filePath: 'src/conflict.ts',
        agentId: agentB.id,
        mode: 'exclusive',
        branch: 'main',
      });
      expect(r2.status).toBe(409);
      const body = (await r2.json()) as { granted: boolean };
      expect(body.granted).toBe(false);
    });

    it('no conflict when branches are different (no conflict record)', async () => {
      await post(`${base}/api/files/claim`, {
        filePath: 'src/isolated.ts',
        agentId: agentA.id,
        mode: 'exclusive',
        branch: 'main',
      });

      await post(`${base}/api/files/claim`, {
        filePath: 'src/isolated.ts',
        agentId: agentB.id,
        mode: 'exclusive',
        branch: 'feature/other',
      });

      const conflictsRes = await get(`${base}/api/conflicts?unresolved=true`);
      const conflictsList = (await conflictsRes.json()) as unknown[];
      // No conflicts should be created for different-branch claims
      const fileConflicts = (conflictsList as { filePaths?: string[] }[]).filter((c) =>
        c.filePaths?.includes('src/isolated.ts'),
      );
      expect(fileConflicts).toHaveLength(0);
    });

    it('checks file ownership via direct endpoint (claimed)', async () => {
      await post(`${base}/api/files/claim`, {
        filePath: 'src/check.ts',
        agentId: agentA.id,
        mode: 'exclusive',
      });

      const res = await get(`${base}/api/files/check/src/check.ts`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { filePath: string; agentId: string };
      expect(body.filePath).toBe('src/check.ts');
      expect(body.agentId).toBe(agentA.id);
    });

    it('checks file ownership via direct endpoint (available)', async () => {
      const res = await get(`${base}/api/files/check/src/unclaimed.ts`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { available: boolean; filePath: string };
      expect(body.available).toBe(true);
      expect(body.filePath).toBe('src/unclaimed.ts');
    });
  });

  // -----------------------------------------------------------------------
  // Tasks
  // -----------------------------------------------------------------------

  describe('Tasks', () => {
    let agent: AgentResponse;

    beforeEach(async () => {
      agent = await registerAgent(base);
    });

    it('creates a task', async () => {
      const res = await post(`${base}/api/tasks`, {
        title: 'Implement auth',
        description: 'Add JWT-based authentication',
        priority: 'high',
      });
      expect(res.status).toBe(201);
      const task = (await res.json()) as { id: string; title: string; status: string };
      expect(task.title).toBe('Implement auth');
      expect(task.status).toBe('pending');
    });

    it('rejects task creation with missing fields', async () => {
      const res = await post(`${base}/api/tasks`, { title: 'No desc' });
      expect(res.status).toBe(400);
    });

    it('assigns a task', async () => {
      const createRes = await post(`${base}/api/tasks`, {
        title: 'Work',
        description: 'Some work',
      });
      const task = (await createRes.json()) as { id: string };

      const res = await post(`${base}/api/tasks/${task.id}/assign`, { agentId: agent.id });
      expect(res.status).toBe(200);
      const assigned = (await res.json()) as { status: string; assignedAgentId: string };
      expect(assigned.status).toBe('in_progress');
      expect(assigned.assignedAgentId).toBe(agent.id);
    });

    it('completes a task', async () => {
      const createRes = await post(`${base}/api/tasks`, {
        title: 'Work',
        description: 'More work',
      });
      const task = (await createRes.json()) as { id: string };
      await post(`${base}/api/tasks/${task.id}/assign`, { agentId: agent.id });

      const res = await post(`${base}/api/tasks/${task.id}/complete`, {});
      expect(res.status).toBe(200);
      const completed = (await res.json()) as { status: string };
      expect(completed.status).toBe('completed');
    });

    it('fails a task', async () => {
      const createRes = await post(`${base}/api/tasks`, {
        title: 'Work',
        description: 'Failing work',
      });
      const task = (await createRes.json()) as { id: string };
      await post(`${base}/api/tasks/${task.id}/assign`, { agentId: agent.id });

      const res = await post(`${base}/api/tasks/${task.id}/fail`, {});
      expect(res.status).toBe(200);
      const failed = (await res.json()) as { status: string };
      expect(failed.status).toBe('failed');
    });

    it('cancels a task', async () => {
      const createRes = await post(`${base}/api/tasks`, {
        title: 'Cancel me',
        description: 'Will be cancelled',
      });
      const task = (await createRes.json()) as { id: string };

      const res = await post(`${base}/api/tasks/${task.id}/cancel`, {});
      expect(res.status).toBe(200);
      const cancelled = (await res.json()) as { status: string };
      expect(cancelled.status).toBe('cancelled');
    });

    it('unassigns a task', async () => {
      const createRes = await post(`${base}/api/tasks`, {
        title: 'Unassign me',
        description: 'Will be unassigned',
      });
      const task = (await createRes.json()) as { id: string };
      await post(`${base}/api/tasks/${task.id}/assign`, { agentId: agent.id });

      const res = await post(`${base}/api/tasks/${task.id}/unassign`, {});
      expect(res.status).toBe(200);
      const unassigned = (await res.json()) as { status: string; assignedAgentId: string | null };
      expect(unassigned.status).toBe('pending');
      expect(unassigned.assignedAgentId).toBeNull();
    });

    it('lists all tasks', async () => {
      await post(`${base}/api/tasks`, { title: 'T1', description: 'D1' });
      await post(`${base}/api/tasks`, { title: 'T2', description: 'D2' });

      const res = await get(`${base}/api/tasks`);
      expect(res.status).toBe(200);
      const tasks = (await res.json()) as unknown[];
      expect(tasks).toHaveLength(2);
    });

    it('gets next available task', async () => {
      await post(`${base}/api/tasks`, { title: 'Next', description: 'Desc' });

      const res = await get(`${base}/api/tasks/next`);
      expect(res.status).toBe(200);
      const task = (await res.json()) as { title: string };
      expect(task.title).toBe('Next');
    });

    it('returns 204 when no tasks available', async () => {
      const res = await get(`${base}/api/tasks/next`);
      expect(res.status).toBe(204);
    });

    it('gets a specific task', async () => {
      const createRes = await post(`${base}/api/tasks`, {
        title: 'Specific',
        description: 'Desc',
      });
      const task = (await createRes.json()) as { id: string };

      const res = await get(`${base}/api/tasks/${task.id}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { title: string };
      expect(body.title).toBe('Specific');
    });

    it('returns 404 for unknown task', async () => {
      const res = await get(`${base}/api/tasks/nonexistent`);
      expect(res.status).toBe(404);
    });

    it('deletes a task', async () => {
      const createRes = await post(`${base}/api/tasks`, {
        title: 'Delete me',
        description: 'Gone',
      });
      const task = (await createRes.json()) as { id: string };

      const res = await del(`${base}/api/tasks/${task.id}`);
      expect(res.status).toBe(200);

      const getRes = await get(`${base}/api/tasks/${task.id}`);
      expect(getRes.status).toBe(404);
    });

    it('rejects assign without agentId', async () => {
      const createRes = await post(`${base}/api/tasks`, {
        title: 'Work',
        description: 'Need agent',
      });
      const task = (await createRes.json()) as { id: string };

      const res = await post(`${base}/api/tasks/${task.id}/assign`, {});
      expect(res.status).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // Knowledge
  // -----------------------------------------------------------------------

  describe('Knowledge', () => {
    let agent: AgentResponse;

    beforeEach(async () => {
      agent = await registerAgent(base);
    });

    it('shares knowledge', async () => {
      const res = await post(`${base}/api/knowledge`, {
        key: 'file:auth.ts:summary',
        value: 'JWT-based auth using bcrypt',
        agentId: agent.id,
      });
      expect(res.status).toBe(201);
      const entry = (await res.json()) as { key: string; value: string };
      expect(entry.key).toBe('file:auth.ts:summary');
      expect(entry.value).toBe('JWT-based auth using bcrypt');
    });

    it('retrieves knowledge by key', async () => {
      await post(`${base}/api/knowledge`, {
        key: 'pattern:error-handling',
        value: 'Result<T, E> pattern',
        agentId: agent.id,
      });

      const res = await get(`${base}/api/knowledge/pattern:error-handling`);
      expect(res.status).toBe(200);
      const entry = (await res.json()) as { key: string; value: string };
      expect(entry.value).toBe('Result<T, E> pattern');
    });

    it('returns 404 for unknown key', async () => {
      const res = await get(`${base}/api/knowledge/nonexistent`);
      expect(res.status).toBe(404);
    });

    it('lists all knowledge', async () => {
      await post(`${base}/api/knowledge`, {
        key: 'k1',
        value: 'v1',
        agentId: agent.id,
      });
      await post(`${base}/api/knowledge`, {
        key: 'k2',
        value: 'v2',
        agentId: agent.id,
      });

      const res = await get(`${base}/api/knowledge`);
      expect(res.status).toBe(200);
      const entries = (await res.json()) as unknown[];
      expect(entries).toHaveLength(2);
    });

    it('deletes knowledge', async () => {
      await post(`${base}/api/knowledge`, {
        key: 'delete-me',
        value: 'gone',
        agentId: agent.id,
      });

      const res = await del(`${base}/api/knowledge/delete-me`);
      expect(res.status).toBe(200);

      const getRes = await get(`${base}/api/knowledge/delete-me`);
      expect(getRes.status).toBe(404);
    });

    it('rejects share with missing fields', async () => {
      const res = await post(`${base}/api/knowledge`, { key: 'no-value' });
      expect(res.status).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // Decisions
  // -----------------------------------------------------------------------

  describe('Decisions', () => {
    let agent: AgentResponse;

    beforeEach(async () => {
      agent = await registerAgent(base);
    });

    it('logs a decision', async () => {
      const res = await post(`${base}/api/decisions`, {
        agentId: agent.id,
        category: 'architecture',
        summary: 'Use microservices',
        rationale: 'Better scaling',
      });
      expect(res.status).toBe(201);
      const decision = (await res.json()) as {
        category: string;
        summary: string;
      };
      expect(decision.category).toBe('architecture');
      expect(decision.summary).toBe('Use microservices');
    });

    it('lists decisions', async () => {
      await post(`${base}/api/decisions`, {
        agentId: agent.id,
        category: 'database',
        summary: 'Use PostgreSQL',
        rationale: 'ACID compliance',
      });

      const res = await get(`${base}/api/decisions`);
      expect(res.status).toBe(200);
      const decisions = (await res.json()) as unknown[];
      expect(decisions).toHaveLength(1);
    });

    it('filters decisions by category', async () => {
      await post(`${base}/api/decisions`, {
        agentId: agent.id,
        category: 'security',
        summary: 'Use bcrypt',
        rationale: 'Industry standard',
      });
      await post(`${base}/api/decisions`, {
        agentId: agent.id,
        category: 'database',
        summary: 'Use SQLite',
        rationale: 'Simplicity',
      });

      const res = await get(`${base}/api/decisions?category=security`);
      expect(res.status).toBe(200);
      const decisions = (await res.json()) as { category: string }[];
      expect(decisions).toHaveLength(1);
      expect(decisions[0]?.category).toBe('security');
    });

    it('rejects decision with missing fields', async () => {
      const res = await post(`${base}/api/decisions`, {
        agentId: agent.id,
        category: 'architecture',
      });
      expect(res.status).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // Conflicts
  // -----------------------------------------------------------------------

  describe('Conflicts', () => {
    let agentA: AgentResponse;
    let agentB: AgentResponse;

    beforeEach(async () => {
      agentA = await registerAgent(base, 'Agent A');
      agentB = await registerAgent(base, 'Agent B');
    });

    it('returns empty list when no conflicts', async () => {
      const res = await get(`${base}/api/conflicts`);
      expect(res.status).toBe(200);
      const conflicts = (await res.json()) as unknown[];
      expect(conflicts).toHaveLength(0);
    });

    it('creates conflict on exclusive file contention', async () => {
      await post(`${base}/api/files/claim`, {
        filePath: 'conflict.ts',
        agentId: agentA.id,
        mode: 'exclusive',
      });
      await post(`${base}/api/files/claim`, {
        filePath: 'conflict.ts',
        agentId: agentB.id,
        mode: 'exclusive',
      });

      const res = await get(`${base}/api/conflicts?unresolved=true`);
      expect(res.status).toBe(200);
      const conflicts = (await res.json()) as { id: string; resolved: boolean }[];
      expect(conflicts.length).toBeGreaterThanOrEqual(1);
      expect(conflicts[0]?.resolved).toBe(false);
    });

    it('resolves a conflict', async () => {
      // Create a conflict
      await post(`${base}/api/files/claim`, {
        filePath: 'r.ts',
        agentId: agentA.id,
        mode: 'exclusive',
      });
      await post(`${base}/api/files/claim`, {
        filePath: 'r.ts',
        agentId: agentB.id,
        mode: 'exclusive',
      });

      const listRes = await get(`${base}/api/conflicts?unresolved=true`);
      const conflicts = (await listRes.json()) as { id: string }[];
      expect(conflicts.length).toBeGreaterThanOrEqual(1);

      const conflictToResolve = conflicts[0];
      if (!conflictToResolve) throw new Error('No conflict found');

      const res = await post(`${base}/api/conflicts/${conflictToResolve.id}/resolve`, {});
      expect(res.status).toBe(200);

      // Verify resolved
      const afterRes = await get(`${base}/api/conflicts?unresolved=true`);
      const after = (await afterRes.json()) as unknown[];
      expect(after).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Status & State
  // -----------------------------------------------------------------------

  describe('Status', () => {
    it('returns compact status', async () => {
      await registerAgent(base, 'StatusAgent');

      const res = await get(`${base}/api/status`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        connectedAgents: number;
        claimedFiles: number;
        unresolvedConflicts: number;
        agents: { displayName: string }[];
      };
      expect(body.connectedAgents).toBe(1);
      expect(body.claimedFiles).toBe(0);
      expect(body.unresolvedConflicts).toBe(0);
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0]?.displayName).toBe('StatusAgent');
    });

    it('returns full state', async () => {
      const agent = await registerAgent(base);
      await post(`${base}/api/tasks`, {
        title: 'State task',
        description: 'desc',
      });
      await post(`${base}/api/knowledge`, {
        key: 'state-key',
        value: 'state-val',
        agentId: agent.id,
      });

      const res = await get(`${base}/api/state`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        agents: unknown[];
        tasks: unknown[];
        knowledge: unknown[];
      };
      expect(body.agents.length).toBeGreaterThanOrEqual(1);
      expect(body.tasks).toHaveLength(1);
      expect(body.knowledge).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Auth middleware
  // -----------------------------------------------------------------------

  describe('Auth', () => {
    let authedServer: HiveMindServer;
    let authedBase: string;

    beforeEach(async () => {
      authedServer = createHiveMindServer(
        testConfig({ authEnabled: true, authToken: 'secret-123' }),
      );
      await authedServer.start();
      authedBase = baseUrl(authedServer);
    });

    afterEach(async () => {
      await authedServer.stop();
    });

    it('health check works without auth', async () => {
      const res = await get(`${authedBase}/health`);
      expect(res.status).toBe(200);
    });

    it('rejects API call without token', async () => {
      const res = await get(`${authedBase}/api/agents`);
      expect(res.status).toBe(401);
    });

    it('rejects API call with wrong token', async () => {
      const res = await get(`${authedBase}/api/agents`, 'wrong-token');
      expect(res.status).toBe(403);
    });

    it('accepts API call with correct token', async () => {
      const res = await get(`${authedBase}/api/agents`, 'secret-123');
      expect(res.status).toBe(200);
    });

    it('allows full workflow with correct token', async () => {
      const regRes = await post(
        `${authedBase}/api/agents/register`,
        { displayName: 'Authed', tool: 'claude-code', workspacePath: '/test' },
        'secret-123',
      );
      expect(regRes.status).toBe(201);
    });
  });

  // -----------------------------------------------------------------------
  // Rate limiting
  // -----------------------------------------------------------------------

  describe('Rate Limiting', () => {
    let limitedServer: HiveMindServer;
    let limitedBase: string;

    beforeEach(async () => {
      limitedServer = createHiveMindServer(
        testConfig({ rateLimitMaxRequests: 3, rateLimitWindowMs: 60_000 }),
      );
      await limitedServer.start();
      limitedBase = baseUrl(limitedServer);
    });

    afterEach(async () => {
      await limitedServer.stop();
    });

    it('returns rate limit headers', async () => {
      const res = await get(`${limitedBase}/api/agents`);
      expect(res.headers.get('x-ratelimit-limit')).toBe('3');
      expect(res.headers.get('x-ratelimit-remaining')).toBeTruthy();
    });

    it('blocks after exceeding rate limit', async () => {
      // Exhaust the limit
      await get(`${limitedBase}/api/agents`);
      await get(`${limitedBase}/api/agents`);
      await get(`${limitedBase}/api/agents`);

      // Fourth request should be blocked
      const res = await get(`${limitedBase}/api/agents`);
      expect(res.status).toBe(429);
    });
  });
});
