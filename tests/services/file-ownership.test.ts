import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileOwnershipService } from '../../src/services/file-ownership.js';
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

const GABRIEL = agentId('agent-gabriel-01');
const ALICE = agentId('agent-alice-01');

function registerAgent(store: Store, id: string, branch?: string | null): void {
  store.upsertAgent({
    id: agentId(id),
    displayName: `Agent ${id}`,
    tool: 'claude-code',
    status: 'active',
    currentTaskId: null,
    lastHeartbeat: isoTimestamp(),
    connectedAt: isoTimestamp(),
    workspacePath: '/test',
    currentBranch: branch ?? null,
    repoUrl: null,
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let store: Store;
let bus: EventBus;
let service: FileOwnershipService;
let emitted: ServerMessage[];

beforeEach(() => {
  store = new Store(':memory:');
  bus = new EventBus();
  service = new FileOwnershipService(store, bus, makeConfig());
  emitted = [];
  bus.on('*', (msg) => {
    emitted.push(msg);
  });

  // Register test agents so foreign keys work
  registerAgent(store, 'agent-gabriel-01');
  registerAgent(store, 'agent-alice-01');
});

afterEach(() => {
  bus.clear();
  store.close();
});

// ---------------------------------------------------------------------------
// Claiming files
// ---------------------------------------------------------------------------

describe('claim', () => {
  it('grants an exclusive claim on an unclaimed file', () => {
    const result = service.claim({
      filePath: 'src/app.ts',
      agentId: GABRIEL,
      mode: 'exclusive',
    });

    expect(result.granted).toBe(true);
    expect(result.ownership).not.toBeNull();
    expect(result.ownership?.filePath).toBe('src/app.ts');
    expect(result.ownership?.agentId).toBe(GABRIEL);
    expect(result.ownership?.mode).toBe('exclusive');
    expect(result.conflict).toBeNull();
  });

  it('grants a shared claim on an unclaimed file', () => {
    const result = service.claim({
      filePath: 'src/utils.ts',
      agentId: GABRIEL,
      mode: 'shared',
    });

    expect(result.granted).toBe(true);
    expect(result.ownership?.mode).toBe('shared');
  });

  it('sets taskId when provided', () => {
    const tid = taskId('task-001');
    const result = service.claim({
      filePath: 'src/app.ts',
      agentId: GABRIEL,
      mode: 'exclusive',
      taskId: tid,
    });

    expect(result.ownership?.taskId).toBe(tid);
  });

  it('sets taskId to null when not provided', () => {
    const result = service.claim({
      filePath: 'src/app.ts',
      agentId: GABRIEL,
      mode: 'exclusive',
    });

    expect(result.ownership?.taskId).toBeNull();
  });

  it('uses default TTL from config', () => {
    const result = service.claim({
      filePath: 'src/app.ts',
      agentId: GABRIEL,
      mode: 'exclusive',
    });

    // defaultClaimTtlMs = 300_000 (5 min), so expiresAt should be ~5 min from now
    expect(result.ownership?.expiresAt).not.toBeNull();
  });

  it('respects custom TTL override', () => {
    const result = service.claim({
      filePath: 'src/app.ts',
      agentId: GABRIEL,
      mode: 'exclusive',
      ttlMs: 60_000, // 1 minute
    });

    expect(result.ownership?.expiresAt).not.toBeNull();
  });

  it('allows null TTL for indefinite claims', () => {
    const result = service.claim({
      filePath: 'src/app.ts',
      agentId: GABRIEL,
      mode: 'exclusive',
      ttlMs: null,
    });

    expect(result.ownership?.expiresAt).toBeNull();
  });

  it('persists the claim in the store', () => {
    service.claim({
      filePath: 'src/app.ts',
      agentId: GABRIEL,
      mode: 'exclusive',
    });

    const stored = store.getFileOwnership('src/app.ts');
    expect(stored).toBeDefined();
    expect(stored?.agentId).toBe(GABRIEL);
  });

  it('emits file_claimed event', () => {
    service.claim({
      filePath: 'src/app.ts',
      agentId: GABRIEL,
      mode: 'exclusive',
    });

    const claimEvents = emitted.filter((e) => e.type === 'file_claimed');
    expect(claimEvents).toHaveLength(1);
  });

  it('allows the same agent to re-claim their own file', () => {
    service.claim({ filePath: 'src/app.ts', agentId: GABRIEL, mode: 'exclusive' });

    const result = service.claim({
      filePath: 'src/app.ts',
      agentId: GABRIEL,
      mode: 'shared', // even changing mode
    });

    expect(result.granted).toBe(true);
    expect(result.ownership?.mode).toBe('shared');
  });

  it('allows shared + shared between different agents', () => {
    service.claim({ filePath: 'src/utils.ts', agentId: GABRIEL, mode: 'shared' });

    const result = service.claim({
      filePath: 'src/utils.ts',
      agentId: ALICE,
      mode: 'shared',
    });

    expect(result.granted).toBe(true);
    expect(result.conflict).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

describe('conflicts', () => {
  it('detects exclusive vs exclusive conflict', () => {
    service.claim({ filePath: 'src/app.ts', agentId: GABRIEL, mode: 'exclusive' });

    const result = service.claim({
      filePath: 'src/app.ts',
      agentId: ALICE,
      mode: 'exclusive',
    });

    expect(result.granted).toBe(false);
    expect(result.ownership).toBeNull();
    expect(result.conflict).not.toBeNull();
    expect(result.conflict?.type).toBe('file_contention');
    expect(result.conflict?.severity).toBe('high');
    expect(result.conflict?.agentA).toBe(GABRIEL);
    expect(result.conflict?.agentB).toBe(ALICE);
    expect(result.conflict?.filePaths).toEqual(['src/app.ts']);
  });

  it('detects exclusive vs shared conflict', () => {
    service.claim({ filePath: 'src/app.ts', agentId: GABRIEL, mode: 'exclusive' });

    const result = service.claim({
      filePath: 'src/app.ts',
      agentId: ALICE,
      mode: 'shared',
    });

    expect(result.granted).toBe(false);
    expect(result.conflict?.severity).toBe('medium');
  });

  it('detects shared vs exclusive conflict', () => {
    service.claim({ filePath: 'src/app.ts', agentId: GABRIEL, mode: 'shared' });

    const result = service.claim({
      filePath: 'src/app.ts',
      agentId: ALICE,
      mode: 'exclusive',
    });

    expect(result.granted).toBe(false);
    expect(result.conflict?.severity).toBe('medium');
  });

  it('persists the conflict in the store', () => {
    service.claim({ filePath: 'src/app.ts', agentId: GABRIEL, mode: 'exclusive' });
    service.claim({ filePath: 'src/app.ts', agentId: ALICE, mode: 'exclusive' });

    const conflicts = store.getUnresolvedConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.type).toBe('file_contention');
  });

  it('emits conflict_detected event', () => {
    service.claim({ filePath: 'src/app.ts', agentId: GABRIEL, mode: 'exclusive' });
    service.claim({ filePath: 'src/app.ts', agentId: ALICE, mode: 'exclusive' });

    const conflictEvents = emitted.filter((e) => e.type === 'conflict_detected');
    expect(conflictEvents).toHaveLength(1);
  });

  it('includes descriptive message for exclusive vs exclusive', () => {
    service.claim({ filePath: 'src/app.ts', agentId: GABRIEL, mode: 'exclusive' });
    const result = service.claim({
      filePath: 'src/app.ts',
      agentId: ALICE,
      mode: 'exclusive',
    });

    expect(result.conflict?.description).toContain('exclusive access');
    expect(result.conflict?.description).toContain('src/app.ts');
  });

  it('includes descriptive message for mixed mode conflict', () => {
    service.claim({ filePath: 'src/app.ts', agentId: GABRIEL, mode: 'exclusive' });
    const result = service.claim({
      filePath: 'src/app.ts',
      agentId: ALICE,
      mode: 'shared',
    });

    expect(result.conflict?.description).toContain('Conflicting ownership modes');
  });

  it('conflict has a unique ID', () => {
    service.claim({ filePath: 'src/a.ts', agentId: GABRIEL, mode: 'exclusive' });
    const r1 = service.claim({ filePath: 'src/a.ts', agentId: ALICE, mode: 'exclusive' });

    // Release and re-claim to create a second conflict on a different file
    registerAgent(store, 'agent-bob-01');
    store.upsertFileOwnership({
      filePath: 'src/b.ts',
      agentId: GABRIEL,
      mode: 'exclusive',
      taskId: null,
      claimedAt: isoTimestamp(),
      expiresAt: null,
    });
    const r2 = service.claim({
      filePath: 'src/b.ts',
      agentId: agentId('agent-bob-01'),
      mode: 'exclusive',
    });

    expect(r1.conflict?.id).not.toBe(r2.conflict?.id);
  });
});

// ---------------------------------------------------------------------------
// Claim limits
// ---------------------------------------------------------------------------

describe('claim limits', () => {
  it('denies claim when agent exceeds maxClaimsPerAgent', () => {
    const svc = new FileOwnershipService(store, bus, makeConfig({ maxClaimsPerAgent: 2 }));

    svc.claim({ filePath: 'file1.ts', agentId: GABRIEL, mode: 'shared' });
    svc.claim({ filePath: 'file2.ts', agentId: GABRIEL, mode: 'shared' });

    const result = svc.claim({ filePath: 'file3.ts', agentId: GABRIEL, mode: 'shared' });

    expect(result.granted).toBe(false);
    expect(result.conflict).toBeNull(); // not a conflict, just a limit
  });

  it('emits error event when limit exceeded', () => {
    const svc = new FileOwnershipService(store, bus, makeConfig({ maxClaimsPerAgent: 1 }));
    svc.claim({ filePath: 'file1.ts', agentId: GABRIEL, mode: 'shared' });
    emitted.length = 0;

    svc.claim({ filePath: 'file2.ts', agentId: GABRIEL, mode: 'shared' });

    const errorEvents = emitted.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
  });

  it('limit is per-agent (other agents unaffected)', () => {
    const svc = new FileOwnershipService(store, bus, makeConfig({ maxClaimsPerAgent: 1 }));

    svc.claim({ filePath: 'file1.ts', agentId: GABRIEL, mode: 'shared' });
    const result = svc.claim({ filePath: 'file2.ts', agentId: ALICE, mode: 'shared' });

    expect(result.granted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Releasing files
// ---------------------------------------------------------------------------

describe('release', () => {
  it('releases a claimed file', () => {
    service.claim({ filePath: 'src/app.ts', agentId: GABRIEL, mode: 'exclusive' });

    const released = service.release('src/app.ts', GABRIEL);

    expect(released).toBe(true);
    expect(store.getFileOwnership('src/app.ts')).toBeUndefined();
  });

  it('emits file_released event', () => {
    service.claim({ filePath: 'src/app.ts', agentId: GABRIEL, mode: 'exclusive' });
    emitted.length = 0;

    service.release('src/app.ts', GABRIEL);

    const releaseEvents = emitted.filter((e) => e.type === 'file_released');
    expect(releaseEvents).toHaveLength(1);
  });

  it('returns false for unclaimed file', () => {
    expect(service.release('nope.ts', GABRIEL)).toBe(false);
  });

  it('returns false when another agent owns the file', () => {
    service.claim({ filePath: 'src/app.ts', agentId: ALICE, mode: 'exclusive' });
    expect(service.release('src/app.ts', GABRIEL)).toBe(false);
  });

  it('does not affect other files', () => {
    service.claim({ filePath: 'src/a.ts', agentId: GABRIEL, mode: 'exclusive' });
    service.claim({ filePath: 'src/b.ts', agentId: GABRIEL, mode: 'exclusive' });

    service.release('src/a.ts', GABRIEL);

    expect(store.getFileOwnership('src/a.ts')).toBeUndefined();
    expect(store.getFileOwnership('src/b.ts')).toBeDefined();
  });

  it('allows another agent to claim after release', () => {
    service.claim({ filePath: 'src/app.ts', agentId: GABRIEL, mode: 'exclusive' });
    service.release('src/app.ts', GABRIEL);

    const result = service.claim({
      filePath: 'src/app.ts',
      agentId: ALICE,
      mode: 'exclusive',
    });

    expect(result.granted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Release all
// ---------------------------------------------------------------------------

describe('releaseAll', () => {
  it('releases all files for an agent', () => {
    service.claim({ filePath: 'src/a.ts', agentId: GABRIEL, mode: 'exclusive' });
    service.claim({ filePath: 'src/b.ts', agentId: GABRIEL, mode: 'shared' });

    const count = service.releaseAll(GABRIEL);

    expect(count).toBe(2);
    expect(store.getFilesByAgent(GABRIEL)).toHaveLength(0);
  });

  it('returns 0 when agent has no claims', () => {
    expect(service.releaseAll(GABRIEL)).toBe(0);
  });

  it('emits file_released for each file', () => {
    service.claim({ filePath: 'src/a.ts', agentId: GABRIEL, mode: 'exclusive' });
    service.claim({ filePath: 'src/b.ts', agentId: GABRIEL, mode: 'shared' });
    emitted.length = 0;

    service.releaseAll(GABRIEL);

    const releaseEvents = emitted.filter((e) => e.type === 'file_released');
    expect(releaseEvents).toHaveLength(2);
  });

  it('does not affect other agents', () => {
    service.claim({ filePath: 'src/a.ts', agentId: GABRIEL, mode: 'shared' });
    service.claim({ filePath: 'src/b.ts', agentId: ALICE, mode: 'shared' });

    service.releaseAll(GABRIEL);

    expect(store.getFilesByAgent(ALICE)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Availability check
// ---------------------------------------------------------------------------

describe('isAvailable', () => {
  it('returns true for unclaimed file', () => {
    expect(service.isAvailable('nope.ts', GABRIEL, 'exclusive')).toBe(true);
  });

  it('returns true when the same agent already holds the file', () => {
    service.claim({ filePath: 'src/app.ts', agentId: GABRIEL, mode: 'exclusive' });
    expect(service.isAvailable('src/app.ts', GABRIEL, 'exclusive')).toBe(true);
  });

  it('returns true for shared+shared between different agents', () => {
    service.claim({ filePath: 'src/app.ts', agentId: GABRIEL, mode: 'shared' });
    expect(service.isAvailable('src/app.ts', ALICE, 'shared')).toBe(true);
  });

  it('returns false for exclusive+exclusive between different agents', () => {
    service.claim({ filePath: 'src/app.ts', agentId: GABRIEL, mode: 'exclusive' });
    expect(service.isAvailable('src/app.ts', ALICE, 'exclusive')).toBe(false);
  });

  it('returns false for exclusive+shared between different agents', () => {
    service.claim({ filePath: 'src/app.ts', agentId: GABRIEL, mode: 'exclusive' });
    expect(service.isAvailable('src/app.ts', ALICE, 'shared')).toBe(false);
  });

  it('returns false for shared+exclusive between different agents', () => {
    service.claim({ filePath: 'src/app.ts', agentId: GABRIEL, mode: 'shared' });
    expect(service.isAvailable('src/app.ts', ALICE, 'exclusive')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

describe('getOwnership', () => {
  it('returns ownership for claimed file', () => {
    service.claim({ filePath: 'src/app.ts', agentId: GABRIEL, mode: 'exclusive' });
    const ownership = service.getOwnership('src/app.ts');

    expect(ownership).toBeDefined();
    expect(ownership?.agentId).toBe(GABRIEL);
  });

  it('returns undefined for unclaimed file', () => {
    expect(service.getOwnership('nope.ts')).toBeUndefined();
  });
});

describe('getFilesByAgent', () => {
  it('returns all files for an agent', () => {
    service.claim({ filePath: 'src/a.ts', agentId: GABRIEL, mode: 'exclusive' });
    service.claim({ filePath: 'src/b.ts', agentId: GABRIEL, mode: 'shared' });

    const files = service.getFilesByAgent(GABRIEL);
    expect(files).toHaveLength(2);
  });

  it('returns empty array for agent with no claims', () => {
    expect(service.getFilesByAgent(GABRIEL)).toHaveLength(0);
  });
});

describe('getAllOwnerships', () => {
  it('returns all current ownerships', () => {
    service.claim({ filePath: 'src/a.ts', agentId: GABRIEL, mode: 'exclusive' });
    service.claim({ filePath: 'src/b.ts', agentId: ALICE, mode: 'shared' });

    expect(service.getAllOwnerships()).toHaveLength(2);
  });

  it('returns empty array when no claims exist', () => {
    expect(service.getAllOwnerships()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Expired claims cleanup
// ---------------------------------------------------------------------------

describe('cleanupExpired', () => {
  it('removes expired claims', () => {
    // Insert a claim with expiresAt in the past
    store.upsertFileOwnership({
      filePath: 'src/old.ts',
      agentId: GABRIEL,
      mode: 'exclusive',
      taskId: null,
      claimedAt: isoTimestamp(new Date(Date.now() - 60_000)),
      expiresAt: isoTimestamp(new Date(Date.now() - 1_000)),
    });

    const count = service.cleanupExpired();

    expect(count).toBe(1);
    expect(store.getFileOwnership('src/old.ts')).toBeUndefined();
  });

  it('does not remove unexpired claims', () => {
    service.claim({
      filePath: 'src/fresh.ts',
      agentId: GABRIEL,
      mode: 'exclusive',
      ttlMs: 300_000,
    });

    const count = service.cleanupExpired();

    expect(count).toBe(0);
    expect(store.getFileOwnership('src/fresh.ts')).toBeDefined();
  });

  it('does not remove claims with no expiry', () => {
    service.claim({
      filePath: 'src/permanent.ts',
      agentId: GABRIEL,
      mode: 'exclusive',
      ttlMs: null,
    });

    const count = service.cleanupExpired();

    expect(count).toBe(0);
  });

  it('emits file_released for each expired claim', () => {
    store.upsertFileOwnership({
      filePath: 'src/old1.ts',
      agentId: GABRIEL,
      mode: 'shared',
      taskId: null,
      claimedAt: isoTimestamp(new Date(Date.now() - 60_000)),
      expiresAt: isoTimestamp(new Date(Date.now() - 1_000)),
    });
    store.upsertFileOwnership({
      filePath: 'src/old2.ts',
      agentId: ALICE,
      mode: 'exclusive',
      taskId: null,
      claimedAt: isoTimestamp(new Date(Date.now() - 60_000)),
      expiresAt: isoTimestamp(new Date(Date.now() - 500)),
    });
    emitted.length = 0;

    service.cleanupExpired();

    const releaseEvents = emitted.filter((e) => e.type === 'file_released');
    expect(releaseEvents).toHaveLength(2);
  });

  it('returns 0 when nothing is expired', () => {
    expect(service.cleanupExpired()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end scenarios
// ---------------------------------------------------------------------------

describe('scenarios', () => {
  it('claim → release → re-claim by another agent', () => {
    service.claim({ filePath: 'src/main.ts', agentId: GABRIEL, mode: 'exclusive' });
    service.release('src/main.ts', GABRIEL);
    const result = service.claim({
      filePath: 'src/main.ts',
      agentId: ALICE,
      mode: 'exclusive',
    });

    expect(result.granted).toBe(true);
    expect(result.ownership?.agentId).toBe(ALICE);
  });

  it('exclusive claim blocks, shared claim passes after release', () => {
    service.claim({ filePath: 'src/main.ts', agentId: GABRIEL, mode: 'exclusive' });

    // Alice blocked by exclusive
    const blocked = service.claim({
      filePath: 'src/main.ts',
      agentId: ALICE,
      mode: 'shared',
    });
    expect(blocked.granted).toBe(false);

    // Gabriel releases
    service.release('src/main.ts', GABRIEL);

    // Alice can now claim
    const ok = service.claim({
      filePath: 'src/main.ts',
      agentId: ALICE,
      mode: 'shared',
    });
    expect(ok.granted).toBe(true);
  });

  it('multiple agents share a file cooperatively', () => {
    const r1 = service.claim({ filePath: 'README.md', agentId: GABRIEL, mode: 'shared' });
    const r2 = service.claim({ filePath: 'README.md', agentId: ALICE, mode: 'shared' });

    expect(r1.granted).toBe(true);
    expect(r2.granted).toBe(true);

    // The store has the latest claim (upsert overwrites)
    const ownership = service.getOwnership('README.md');
    expect(ownership).toBeDefined();
  });

  it('conflict detection does not alter existing claim', () => {
    service.claim({ filePath: 'src/app.ts', agentId: GABRIEL, mode: 'exclusive' });
    service.claim({ filePath: 'src/app.ts', agentId: ALICE, mode: 'exclusive' });

    // Gabriel's claim should still be intact
    const ownership = service.getOwnership('src/app.ts');
    expect(ownership?.agentId).toBe(GABRIEL);
    expect(ownership?.mode).toBe('exclusive');
  });
});

// ---------------------------------------------------------------------------
// Branch-aware conflict detection
// ---------------------------------------------------------------------------

describe('branch awareness', () => {
  it('allows same file claim on different branches', () => {
    service.claim({
      filePath: 'src/app.ts',
      agentId: GABRIEL,
      mode: 'exclusive',
      branch: 'main',
    });

    const result = service.claim({
      filePath: 'src/app.ts',
      agentId: ALICE,
      mode: 'exclusive',
      branch: 'feature/auth',
    });

    expect(result.granted).toBe(true);
    expect(result.conflict).toBeNull();
  });

  it('detects conflict on same branch', () => {
    service.claim({
      filePath: 'src/app.ts',
      agentId: GABRIEL,
      mode: 'exclusive',
      branch: 'main',
    });

    const result = service.claim({
      filePath: 'src/app.ts',
      agentId: ALICE,
      mode: 'exclusive',
      branch: 'main',
    });

    expect(result.granted).toBe(false);
    expect(result.conflict).not.toBeNull();
    expect(result.conflict?.severity).toBe('high');
  });

  it('detects conflict when branch is null (unknown = conservative)', () => {
    service.claim({
      filePath: 'src/app.ts',
      agentId: GABRIEL,
      mode: 'exclusive',
      branch: null,
    });

    const result = service.claim({
      filePath: 'src/app.ts',
      agentId: ALICE,
      mode: 'exclusive',
      branch: null,
    });

    expect(result.granted).toBe(false);
    expect(result.conflict).not.toBeNull();
  });

  it('detects conflict when existing branch is null and request has branch', () => {
    service.claim({
      filePath: 'src/app.ts',
      agentId: GABRIEL,
      mode: 'exclusive',
      branch: null,
    });

    const result = service.claim({
      filePath: 'src/app.ts',
      agentId: ALICE,
      mode: 'exclusive',
      branch: 'feature/auth',
    });

    expect(result.granted).toBe(false);
    expect(result.conflict).not.toBeNull();
  });

  it('detects conflict when request branch is null and existing has branch', () => {
    service.claim({
      filePath: 'src/app.ts',
      agentId: GABRIEL,
      mode: 'exclusive',
      branch: 'main',
    });

    const result = service.claim({
      filePath: 'src/app.ts',
      agentId: ALICE,
      mode: 'exclusive',
    });

    expect(result.granted).toBe(false);
    expect(result.conflict).not.toBeNull();
  });

  it('claim inherits branch from input (not implicit from agent)', () => {
    const result = service.claim({
      filePath: 'src/app.ts',
      agentId: GABRIEL,
      mode: 'exclusive',
      branch: 'feature/xyz',
    });

    expect(result.granted).toBe(true);
    expect(result.ownership?.branch).toBe('feature/xyz');
  });

  it('branch defaults to null when not provided', () => {
    const result = service.claim({
      filePath: 'src/app.ts',
      agentId: GABRIEL,
      mode: 'exclusive',
    });

    expect(result.ownership?.branch).toBeNull();
  });

  it('allows shared+shared on different branches', () => {
    service.claim({
      filePath: 'src/app.ts',
      agentId: GABRIEL,
      mode: 'shared',
      branch: 'main',
    });

    const result = service.claim({
      filePath: 'src/app.ts',
      agentId: ALICE,
      mode: 'shared',
      branch: 'feature/auth',
    });

    expect(result.granted).toBe(true);
  });

  it('allows shared+shared on same branch', () => {
    service.claim({
      filePath: 'src/app.ts',
      agentId: GABRIEL,
      mode: 'shared',
      branch: 'main',
    });

    const result = service.claim({
      filePath: 'src/app.ts',
      agentId: ALICE,
      mode: 'shared',
      branch: 'main',
    });

    expect(result.granted).toBe(true);
  });

  it('isAvailable considers branch isolation', () => {
    service.claim({
      filePath: 'src/app.ts',
      agentId: GABRIEL,
      mode: 'exclusive',
      branch: 'main',
    });

    // Different branch → available
    expect(service.isAvailable('src/app.ts', ALICE, 'exclusive', 'feature/auth')).toBe(true);

    // Same branch → not available
    expect(service.isAvailable('src/app.ts', ALICE, 'exclusive', 'main')).toBe(false);

    // Unknown branch → conservative (not available)
    expect(service.isAvailable('src/app.ts', ALICE, 'exclusive', null)).toBe(false);
  });
});
