import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRegistry } from '../../src/services/agent-registry.js';
import type { RegisterInput } from '../../src/services/agent-registry.js';
import { Store } from '../../src/services/store.js';
import { EventBus } from '../../src/services/event-bus.js';
import type { Config } from '../../src/config.js';
import type { ServerMessage } from '../../src/types.js';
import { agentId, taskId, isoTimestamp } from '../../src/schemas.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 7777,
    host: '0.0.0.0',
    dbPath: ':memory:',
    authToken: 'test',
    authEnabled: false,
    corsOrigins: ['*'],
    rateLimitWindowMs: 60_000,
    rateLimitMaxRequests: 200,
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
    staleAgentCleanupMs: 60_000,
    defaultClaimTtlMs: 300_000,
    maxClaimsPerAgent: 50,
    defaultKnowledgeTtlSeconds: 3600,
    maxKnowledgeEntries: 1000,
    wsMaxPayloadBytes: 1_048_576,
    wsPingIntervalMs: 15_000,
    dashboardEnabled: true,
    nodeEnv: 'test',
    logLevel: 'error',
    ...overrides,
  };
}

const GABRIEL_INPUT: RegisterInput = {
  displayName: "Gabriel's Claude Code",
  tool: 'claude-code',
  workspacePath: '/home/gabriel/project',
};

const ALICE_INPUT: RegisterInput = {
  displayName: "Alice's Cursor",
  tool: 'cursor',
  workspacePath: '/home/alice/project',
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let store: Store;
let bus: EventBus;
let registry: AgentRegistry;
let emitted: ServerMessage[];

beforeEach(() => {
  store = new Store(':memory:');
  bus = new EventBus();
  registry = new AgentRegistry(store, bus, makeConfig());
  emitted = [];
  bus.on('*', (msg) => {
    emitted.push(msg);
  });
});

afterEach(() => {
  registry.stopCleanupInterval();
  bus.clear();
  store.close();
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('register', () => {
  it('creates an agent with a UUID', () => {
    const agent = registry.register(GABRIEL_INPUT);
    expect(agent.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets displayName, tool, and workspacePath from input', () => {
    const agent = registry.register(GABRIEL_INPUT);
    expect(agent.displayName).toBe("Gabriel's Claude Code");
    expect(agent.tool).toBe('claude-code');
    expect(agent.workspacePath).toBe('/home/gabriel/project');
  });

  it('starts with active status and no task', () => {
    const agent = registry.register(GABRIEL_INPUT);
    expect(agent.status).toBe('active');
    expect(agent.currentTaskId).toBeNull();
  });

  it('sets connectedAt and lastHeartbeat to now', () => {
    const before = new Date().toISOString();
    const agent = registry.register(GABRIEL_INPUT);
    const after = new Date().toISOString();
    expect(agent.connectedAt >= before).toBe(true);
    expect(agent.connectedAt <= after).toBe(true);
    expect(agent.lastHeartbeat).toBe(agent.connectedAt);
  });

  it('persists the agent in the store', () => {
    const agent = registry.register(GABRIEL_INPUT);
    const stored = store.getAgent(agent.id);
    expect(stored).toEqual(agent);
  });

  it('emits agent_joined event', () => {
    const agent = registry.register(GABRIEL_INPUT);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({ type: 'agent_joined', agent });
  });

  it('generates unique IDs for each registration', () => {
    const agent1 = registry.register(GABRIEL_INPUT);
    const agent2 = registry.register(ALICE_INPUT);
    expect(agent1.id).not.toBe(agent2.id);
  });

  it('supports all tool types', () => {
    const tools = ['claude-code', 'cursor', 'copilot', 'codex', 'windsurf', 'other'] as const;
    for (const tool of tools) {
      const agent = registry.register({ ...GABRIEL_INPUT, tool });
      expect(agent.tool).toBe(tool);
    }
  });
});

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

describe('heartbeat', () => {
  it('updates the lastHeartbeat timestamp', async () => {
    const agent = registry.register(GABRIEL_INPUT);
    const originalHb = agent.lastHeartbeat;

    // Wait 2ms to guarantee a different ISO timestamp
    await new Promise((resolve) => setTimeout(resolve, 2));
    const result = registry.heartbeat(agent.id);

    expect(result).toBe(true);
    const updated = store.getAgent(agent.id);
    expect(updated?.lastHeartbeat).not.toBe(originalHb);
  });

  it('returns false for non-existent agent', () => {
    expect(registry.heartbeat(agentId('nope'))).toBe(false);
  });

  it('revives idle agents to active', () => {
    const agent = registry.register(GABRIEL_INPUT);
    store.updateAgentStatus(agent.id, 'idle');

    registry.heartbeat(agent.id);

    expect(store.getAgent(agent.id)?.status).toBe('active');
  });

  it('does not change busy status', () => {
    const agent = registry.register(GABRIEL_INPUT);
    store.updateAgentStatus(agent.id, 'busy');

    registry.heartbeat(agent.id);

    expect(store.getAgent(agent.id)?.status).toBe('busy');
  });

  it('emits agent_heartbeat event', () => {
    const agent = registry.register(GABRIEL_INPUT);
    emitted.length = 0; // clear registration event

    registry.heartbeat(agent.id);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.type).toBe('agent_heartbeat');
  });

  it('does not emit event for non-existent agent', () => {
    emitted.length = 0;
    registry.heartbeat(agentId('nope'));
    expect(emitted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Status changes
// ---------------------------------------------------------------------------

describe('markBusy', () => {
  it('sets status to busy and assigns task', () => {
    const agent = registry.register(GABRIEL_INPUT);
    const tid = taskId('task-001');

    const result = registry.markBusy(agent.id, tid);

    expect(result).toBe(true);
    const updated = store.getAgent(agent.id);
    expect(updated?.status).toBe('busy');
    expect(updated?.currentTaskId).toBe(tid);
  });

  it('returns false for non-existent agent', () => {
    expect(registry.markBusy(agentId('nope'), taskId('t1'))).toBe(false);
  });
});

describe('markIdle', () => {
  it('sets status to idle and clears task', () => {
    const agent = registry.register(GABRIEL_INPUT);
    registry.markBusy(agent.id, taskId('task-001'));

    const result = registry.markIdle(agent.id);

    expect(result).toBe(true);
    const updated = store.getAgent(agent.id);
    expect(updated?.status).toBe('idle');
    expect(updated?.currentTaskId).toBeNull();
  });

  it('returns false for non-existent agent', () => {
    expect(registry.markIdle(agentId('nope'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------

describe('disconnect', () => {
  it('sets status to disconnected', () => {
    const agent = registry.register(GABRIEL_INPUT);
    registry.disconnect(agent.id);
    expect(store.getAgent(agent.id)?.status).toBe('disconnected');
  });

  it('clears current task', () => {
    const agent = registry.register(GABRIEL_INPUT);
    registry.markBusy(agent.id, taskId('task-001'));

    registry.disconnect(agent.id);

    expect(store.getAgent(agent.id)?.currentTaskId).toBeNull();
  });

  it('releases all file claims', () => {
    const agent = registry.register(GABRIEL_INPUT);
    store.upsertFileOwnership({
      filePath: 'src/test.ts',
      agentId: agent.id,
      mode: 'exclusive',
      taskId: null,
      claimedAt: isoTimestamp(),
      expiresAt: null,
    });

    registry.disconnect(agent.id);

    expect(store.getFilesByAgent(agent.id)).toHaveLength(0);
  });

  it('emits agent_left event', () => {
    const agent = registry.register(GABRIEL_INPUT);
    emitted.length = 0;

    registry.disconnect(agent.id);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({ type: 'agent_left', agentId: agent.id });
  });

  it('returns false for non-existent agent', () => {
    expect(registry.disconnect(agentId('nope'))).toBe(false);
  });

  it('keeps the agent record (just marks as disconnected)', () => {
    const agent = registry.register(GABRIEL_INPUT);
    registry.disconnect(agent.id);
    expect(store.getAgent(agent.id)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Remove (permanent deletion)
// ---------------------------------------------------------------------------

describe('remove', () => {
  it('permanently deletes the agent record', () => {
    const agent = registry.register(GABRIEL_INPUT);
    registry.remove(agent.id);
    expect(store.getAgent(agent.id)).toBeUndefined();
  });

  it('emits agent_left event', () => {
    const agent = registry.register(GABRIEL_INPUT);
    emitted.length = 0;

    registry.remove(agent.id);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({ type: 'agent_left', agentId: agent.id });
  });

  it('returns false for non-existent agent', () => {
    expect(registry.remove(agentId('nope'))).toBe(false);
  });

  it('cascades to file claims via foreign key', () => {
    const agent = registry.register(GABRIEL_INPUT);
    store.upsertFileOwnership({
      filePath: 'src/test.ts',
      agentId: agent.id,
      mode: 'exclusive',
      taskId: null,
      claimedAt: isoTimestamp(),
      expiresAt: null,
    });

    registry.remove(agent.id);

    expect(store.getAllFileOwnerships()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

describe('getAgent', () => {
  it('returns the agent if it exists', () => {
    const agent = registry.register(GABRIEL_INPUT);
    expect(registry.getAgent(agent.id)).toEqual(agent);
  });

  it('returns undefined if not found', () => {
    expect(registry.getAgent(agentId('nope'))).toBeUndefined();
  });
});

describe('getAllAgents', () => {
  it('returns empty array when no agents', () => {
    expect(registry.getAllAgents()).toEqual([]);
  });

  it('returns all agents including disconnected', () => {
    const agent1 = registry.register(GABRIEL_INPUT);
    registry.register(ALICE_INPUT);
    registry.disconnect(agent1.id);

    expect(registry.getAllAgents()).toHaveLength(2);
  });
});

describe('getConnectedAgents', () => {
  it('excludes disconnected agents', () => {
    const agent1 = registry.register(GABRIEL_INPUT);
    registry.register(ALICE_INPUT);
    registry.disconnect(agent1.id);

    const connected = registry.getConnectedAgents();
    expect(connected).toHaveLength(1);
    expect(connected[0]?.displayName).toBe("Alice's Cursor");
  });

  it('includes active, busy, and idle agents', () => {
    const a1 = registry.register(GABRIEL_INPUT);
    const a2 = registry.register(ALICE_INPUT);
    registry.register({ ...GABRIEL_INPUT, displayName: 'Bob' });

    registry.markBusy(a1.id, taskId('t1'));
    registry.markIdle(a2.id);
    // a3 stays active

    const connected = registry.getConnectedAgents();
    expect(connected).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Stale cleanup
// ---------------------------------------------------------------------------

describe('cleanupStale', () => {
  it('disconnects agents with old heartbeats', () => {
    const agent = registry.register(GABRIEL_INPUT);

    // Manually set heartbeat to the past
    const old = isoTimestamp(new Date(Date.now() - 60_000));
    store.updateAgentHeartbeat(agent.id, old);

    // Config has heartbeatTimeoutMs = 30_000
    const cleaned = registry.cleanupStale();

    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]).toBe(agent.id);
    expect(store.getAgent(agent.id)?.status).toBe('disconnected');
  });

  it('does not disconnect agents with recent heartbeats', () => {
    registry.register(GABRIEL_INPUT);
    // heartbeat was just set to now

    const cleaned = registry.cleanupStale();
    expect(cleaned).toHaveLength(0);
  });

  it('does not double-disconnect already disconnected agents', () => {
    const agent = registry.register(GABRIEL_INPUT);
    registry.disconnect(agent.id);

    // Set old heartbeat
    const old = isoTimestamp(new Date(Date.now() - 60_000));
    store.updateAgentHeartbeat(agent.id, old);

    const cleaned = registry.cleanupStale();
    expect(cleaned).toHaveLength(0);
  });

  it('releases file claims of cleaned-up agents', () => {
    const agent = registry.register(GABRIEL_INPUT);
    store.upsertFileOwnership({
      filePath: 'src/test.ts',
      agentId: agent.id,
      mode: 'exclusive',
      taskId: null,
      claimedAt: isoTimestamp(),
      expiresAt: null,
    });

    const old = isoTimestamp(new Date(Date.now() - 60_000));
    store.updateAgentHeartbeat(agent.id, old);

    registry.cleanupStale();

    expect(store.getFilesByAgent(agent.id)).toHaveLength(0);
  });

  it('emits agent_left for each cleaned agent', () => {
    const agent1 = registry.register(GABRIEL_INPUT);
    const agent2 = registry.register(ALICE_INPUT);
    emitted.length = 0;

    const old = isoTimestamp(new Date(Date.now() - 60_000));
    store.updateAgentHeartbeat(agent1.id, old);
    store.updateAgentHeartbeat(agent2.id, old);

    registry.cleanupStale();

    const leftEvents = emitted.filter((e) => e.type === 'agent_left');
    expect(leftEvents).toHaveLength(2);
  });

  it('respects custom heartbeat timeout from config', () => {
    const shortTimeout = makeConfig({ heartbeatTimeoutMs: 5_000 });
    const shortRegistry = new AgentRegistry(store, bus, shortTimeout);

    const agent = shortRegistry.register(GABRIEL_INPUT);

    // Set heartbeat to 6 seconds ago (just past the 5s timeout)
    const old = isoTimestamp(new Date(Date.now() - 6_000));
    store.updateAgentHeartbeat(agent.id, old);

    const cleaned = shortRegistry.cleanupStale();
    expect(cleaned).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Cleanup interval
// ---------------------------------------------------------------------------

describe('cleanup interval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts and runs periodically', () => {
    const config = makeConfig({ staleAgentCleanupMs: 1_000 });
    const timedRegistry = new AgentRegistry(store, bus, config);

    const spy = vi.spyOn(timedRegistry, 'cleanupStale');
    timedRegistry.startCleanupInterval();

    vi.advanceTimersByTime(3_500);
    expect(spy).toHaveBeenCalledTimes(3);

    timedRegistry.stopCleanupInterval();
  });

  it('is idempotent (starting twice does not create duplicate timers)', () => {
    const config = makeConfig({ staleAgentCleanupMs: 1_000 });
    const timedRegistry = new AgentRegistry(store, bus, config);

    const spy = vi.spyOn(timedRegistry, 'cleanupStale');
    timedRegistry.startCleanupInterval();
    timedRegistry.startCleanupInterval(); // second call is no-op

    vi.advanceTimersByTime(1_500);
    expect(spy).toHaveBeenCalledTimes(1); // not 2

    timedRegistry.stopCleanupInterval();
  });

  it('stops cleanly', () => {
    const config = makeConfig({ staleAgentCleanupMs: 1_000 });
    const timedRegistry = new AgentRegistry(store, bus, config);

    const spy = vi.spyOn(timedRegistry, 'cleanupStale');
    timedRegistry.startCleanupInterval();

    vi.advanceTimersByTime(1_500);
    expect(spy).toHaveBeenCalledTimes(1);

    timedRegistry.stopCleanupInterval();

    vi.advanceTimersByTime(5_000);
    expect(spy).toHaveBeenCalledTimes(1); // no more calls
  });

  it('stopCleanupInterval is safe to call without start', () => {
    // Should not throw
    registry.stopCleanupInterval();
  });
});

// ---------------------------------------------------------------------------
// Branch context
// ---------------------------------------------------------------------------

describe('branch context', () => {
  it('registers agent with branch context', () => {
    const agent = registry.register({
      ...GABRIEL_INPUT,
      currentBranch: 'main',
      repoUrl: 'https://github.com/dev-smurf/project.git',
    });

    expect(agent.currentBranch).toBe('main');
    expect(agent.repoUrl).toBe('https://github.com/dev-smurf/project.git');
  });

  it('defaults branch and repoUrl to null when not provided', () => {
    const agent = registry.register(GABRIEL_INPUT);
    expect(agent.currentBranch).toBeNull();
    expect(agent.repoUrl).toBeNull();
  });

  it('persists branch context in the store', () => {
    const agent = registry.register({
      ...GABRIEL_INPUT,
      currentBranch: 'feature/auth',
      repoUrl: 'https://github.com/test/repo.git',
    });

    const stored = store.getAgent(agent.id);
    expect(stored?.currentBranch).toBe('feature/auth');
    expect(stored?.repoUrl).toBe('https://github.com/test/repo.git');
  });

  it('updates agent branch', () => {
    const agent = registry.register({
      ...GABRIEL_INPUT,
      currentBranch: 'main',
    });

    const ok = registry.updateBranch(agent.id, 'feature/new');
    expect(ok).toBe(true);

    const updated = store.getAgent(agent.id);
    expect(updated?.currentBranch).toBe('feature/new');
  });

  it('updateBranch returns false for non-existent agent', () => {
    expect(registry.updateBranch(agentId('nope'), 'main')).toBe(false);
  });

  it('updateBranch accepts null to clear branch', () => {
    const agent = registry.register({
      ...GABRIEL_INPUT,
      currentBranch: 'main',
    });

    registry.updateBranch(agent.id, null);
    expect(store.getAgent(agent.id)?.currentBranch).toBeNull();
  });
});
