import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeStore } from '../../src/services/knowledge-store.js';
import { Store } from '../../src/services/store.js';
import { EventBus } from '../../src/services/event-bus.js';
import type { Config } from '../../src/config.js';
import type { ServerMessage } from '../../src/types.js';
import { agentId, isoTimestamp } from '../../src/schemas.js';

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

function registerAgent(store: Store, id: string): void {
  store.upsertAgent({
    id: agentId(id),
    displayName: `Agent ${id}`,
    tool: 'claude-code',
    status: 'active',
    currentTaskId: null,
    lastHeartbeat: isoTimestamp(),
    connectedAt: isoTimestamp(),
    workspacePath: '/test',
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let store: Store;
let bus: EventBus;
let knowledge: KnowledgeStore;
let emitted: ServerMessage[];

beforeEach(() => {
  store = new Store(':memory:');
  bus = new EventBus();
  knowledge = new KnowledgeStore(store, bus, makeConfig());
  emitted = [];
  bus.on('*', (msg) => {
    emitted.push(msg);
  });

  registerAgent(store, 'agent-gabriel-01');
  registerAgent(store, 'agent-alice-01');
});

afterEach(() => {
  bus.clear();
  store.close();
});

// ---------------------------------------------------------------------------
// Sharing knowledge
// ---------------------------------------------------------------------------

describe('share', () => {
  it('stores a knowledge entry', () => {
    const entry = knowledge.share({
      key: 'file:src/auth.ts:summary',
      value: 'Handles JWT-based authentication',
      agentId: GABRIEL,
    });

    expect(entry.key).toBe('file:src/auth.ts:summary');
    expect(entry.value).toBe('Handles JWT-based authentication');
    expect(entry.agentId).toBe(GABRIEL);
  });

  it('sets sourceHash to null when not provided', () => {
    const entry = knowledge.share({
      key: 'test-key',
      value: 'test-value',
      agentId: GABRIEL,
    });

    expect(entry.sourceHash).toBeNull();
  });

  it('sets sourceHash when provided', () => {
    const entry = knowledge.share({
      key: 'test-key',
      value: 'test-value',
      agentId: GABRIEL,
      sourceHash: 'abc123',
    });

    expect(entry.sourceHash).toBe('abc123');
  });

  it('uses default TTL from config', () => {
    const entry = knowledge.share({
      key: 'test-key',
      value: 'test-value',
      agentId: GABRIEL,
    });

    expect(entry.ttlSeconds).toBe(3600); // config default
  });

  it('respects custom TTL override', () => {
    const entry = knowledge.share({
      key: 'test-key',
      value: 'test-value',
      agentId: GABRIEL,
      ttlSeconds: 60,
    });

    expect(entry.ttlSeconds).toBe(60);
  });

  it('allows null TTL for permanent entries', () => {
    const entry = knowledge.share({
      key: 'test-key',
      value: 'test-value',
      agentId: GABRIEL,
      ttlSeconds: null,
    });

    expect(entry.ttlSeconds).toBeNull();
  });

  it('persists in the store', () => {
    knowledge.share({
      key: 'test-key',
      value: 'test-value',
      agentId: GABRIEL,
    });

    const stored = store.getKnowledge('test-key');
    expect(stored).toBeDefined();
    expect(stored?.value).toBe('test-value');
  });

  it('emits knowledge_shared event', () => {
    knowledge.share({
      key: 'test-key',
      value: 'test-value',
      agentId: GABRIEL,
    });

    const shareEvents = emitted.filter((e) => e.type === 'knowledge_shared');
    expect(shareEvents).toHaveLength(1);
  });

  it('updates existing entry with same key', () => {
    knowledge.share({ key: 'test-key', value: 'v1', agentId: GABRIEL });
    knowledge.share({ key: 'test-key', value: 'v2', agentId: ALICE });

    const stored = store.getKnowledge('test-key');
    expect(stored?.value).toBe('v2');
    expect(stored?.agentId).toBe(ALICE);
  });

  it('sets createdAt timestamp', () => {
    const before = new Date().toISOString();
    const entry = knowledge.share({
      key: 'test-key',
      value: 'test-value',
      agentId: GABRIEL,
    });
    const after = new Date().toISOString();

    expect(entry.createdAt >= before).toBe(true);
    expect(entry.createdAt <= after).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Capacity management
// ---------------------------------------------------------------------------

describe('capacity', () => {
  it('evicts oldest when at capacity', () => {
    const ks = new KnowledgeStore(store, bus, makeConfig({ maxKnowledgeEntries: 3 }));

    ks.share({ key: 'a', value: '1', agentId: GABRIEL });
    ks.share({ key: 'b', value: '2', agentId: GABRIEL });
    ks.share({ key: 'c', value: '3', agentId: GABRIEL });

    // Adding a 4th should evict the oldest
    ks.share({ key: 'd', value: '4', agentId: GABRIEL });

    expect(ks.count()).toBeLessThanOrEqual(3);
    // 'd' should exist as the newest
    expect(store.getKnowledge('d')).toBeDefined();
  });

  it('does not evict when updating an existing key', () => {
    const ks = new KnowledgeStore(store, bus, makeConfig({ maxKnowledgeEntries: 2 }));

    ks.share({ key: 'a', value: '1', agentId: GABRIEL });
    ks.share({ key: 'b', value: '2', agentId: GABRIEL });

    // Update 'a' — should NOT trigger eviction
    ks.share({ key: 'a', value: 'updated', agentId: GABRIEL });

    expect(store.getKnowledge('a')?.value).toBe('updated');
    expect(store.getKnowledge('b')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

describe('get', () => {
  it('returns entry by key', () => {
    knowledge.share({ key: 'test-key', value: 'test-value', agentId: GABRIEL });
    const entry = knowledge.get('test-key');

    expect(entry).toBeDefined();
    expect(entry?.value).toBe('test-value');
  });

  it('returns undefined for non-existent key', () => {
    expect(knowledge.get('nope')).toBeUndefined();
  });
});

describe('getAll', () => {
  it('returns all entries', () => {
    knowledge.share({ key: 'a', value: '1', agentId: GABRIEL });
    knowledge.share({ key: 'b', value: '2', agentId: ALICE });

    expect(knowledge.getAll()).toHaveLength(2);
  });

  it('returns empty array when no entries', () => {
    expect(knowledge.getAll()).toHaveLength(0);
  });
});

describe('count', () => {
  it('returns the current entry count', () => {
    expect(knowledge.count()).toBe(0);

    knowledge.share({ key: 'a', value: '1', agentId: GABRIEL });
    expect(knowledge.count()).toBe(1);

    knowledge.share({ key: 'b', value: '2', agentId: GABRIEL });
    expect(knowledge.count()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Validity check (source hash)
// ---------------------------------------------------------------------------

describe('isValid', () => {
  it('returns false for non-existent key', () => {
    expect(knowledge.isValid('nope', null)).toBe(false);
  });

  it('returns true when entry has no sourceHash', () => {
    knowledge.share({ key: 'test', value: 'v', agentId: GABRIEL });
    expect(knowledge.isValid('test', 'any-hash')).toBe(true);
  });

  it('returns true when sourceHash matches', () => {
    knowledge.share({
      key: 'test',
      value: 'v',
      agentId: GABRIEL,
      sourceHash: 'abc123',
    });
    expect(knowledge.isValid('test', 'abc123')).toBe(true);
  });

  it('returns false when sourceHash mismatches', () => {
    knowledge.share({
      key: 'test',
      value: 'v',
      agentId: GABRIEL,
      sourceHash: 'abc123',
    });
    expect(knowledge.isValid('test', 'def456')).toBe(false);
  });

  it('returns true when both hashes are null', () => {
    knowledge.share({ key: 'test', value: 'v', agentId: GABRIEL });
    expect(knowledge.isValid('test', null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

describe('delete', () => {
  it('deletes an existing entry', () => {
    knowledge.share({ key: 'test', value: 'v', agentId: GABRIEL });

    const deleted = knowledge.delete('test');

    expect(deleted).toBe(true);
    expect(store.getKnowledge('test')).toBeUndefined();
  });

  it('returns false for non-existent key', () => {
    expect(knowledge.delete('nope')).toBe(false);
  });

  it('decrements the count', () => {
    knowledge.share({ key: 'a', value: '1', agentId: GABRIEL });
    knowledge.share({ key: 'b', value: '2', agentId: GABRIEL });
    expect(knowledge.count()).toBe(2);

    knowledge.delete('a');
    expect(knowledge.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Expired entry cleanup
// ---------------------------------------------------------------------------

describe('cleanupExpired', () => {
  it('removes expired entries', () => {
    // Insert entry that expired 10 seconds ago (ttl=1, created 11s ago)
    store.upsertKnowledge({
      key: 'old',
      value: 'stale',
      agentId: GABRIEL,
      sourceHash: null,
      createdAt: isoTimestamp(new Date(Date.now() - 11_000)),
      ttlSeconds: 1,
    });

    const count = knowledge.cleanupExpired();

    expect(count).toBe(1);
    expect(store.getKnowledge('old')).toBeUndefined();
  });

  it('does not remove unexpired entries', () => {
    knowledge.share({
      key: 'fresh',
      value: 'good',
      agentId: GABRIEL,
      ttlSeconds: 3600,
    });

    const count = knowledge.cleanupExpired();

    expect(count).toBe(0);
    expect(store.getKnowledge('fresh')).toBeDefined();
  });

  it('does not remove permanent entries (null TTL)', () => {
    knowledge.share({
      key: 'permanent',
      value: 'forever',
      agentId: GABRIEL,
      ttlSeconds: null,
    });

    const count = knowledge.cleanupExpired();

    expect(count).toBe(0);
  });

  it('returns 0 when nothing is expired', () => {
    expect(knowledge.cleanupExpired()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end scenarios
// ---------------------------------------------------------------------------

describe('scenarios', () => {
  it('two agents share and update knowledge', () => {
    knowledge.share({
      key: 'file:src/auth.ts:summary',
      value: 'Basic auth with bcrypt',
      agentId: GABRIEL,
      sourceHash: 'hash-v1',
    });

    // Alice re-analyzes the file after changes
    knowledge.share({
      key: 'file:src/auth.ts:summary',
      value: 'JWT + OAuth2 with refresh tokens',
      agentId: ALICE,
      sourceHash: 'hash-v2',
    });

    const entry = knowledge.get('file:src/auth.ts:summary');
    expect(entry?.value).toBe('JWT + OAuth2 with refresh tokens');
    expect(entry?.agentId).toBe(ALICE);
    expect(entry?.sourceHash).toBe('hash-v2');
  });

  it('invalidation via source hash change', () => {
    knowledge.share({
      key: 'file:src/app.ts:summary',
      value: 'Main entry point',
      agentId: GABRIEL,
      sourceHash: 'hash-old',
    });

    // File has changed — old hash no longer valid
    expect(knowledge.isValid('file:src/app.ts:summary', 'hash-old')).toBe(true);
    expect(knowledge.isValid('file:src/app.ts:summary', 'hash-new')).toBe(false);
  });

  it('share → expire → cleanup → share fresh', () => {
    // Insert already-expired entry
    store.upsertKnowledge({
      key: 'test',
      value: 'old',
      agentId: GABRIEL,
      sourceHash: null,
      createdAt: isoTimestamp(new Date(Date.now() - 120_000)),
      ttlSeconds: 60,
    });

    knowledge.cleanupExpired();
    expect(knowledge.get('test')).toBeUndefined();

    // Share fresh
    knowledge.share({ key: 'test', value: 'new', agentId: ALICE });
    expect(knowledge.get('test')?.value).toBe('new');
  });
});
