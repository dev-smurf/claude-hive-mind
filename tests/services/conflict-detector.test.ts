import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictDetector } from '../../src/services/conflict-detector.js';
import { Store } from '../../src/services/store.js';
import { EventBus } from '../../src/services/event-bus.js';
import type { Conflict, ServerMessage } from '../../src/types.js';
import { agentId, conflictId, isoTimestamp } from '../../src/schemas.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeConflict(id: string, resolved = false): Conflict {
  return {
    id: conflictId(id),
    type: 'file_contention',
    severity: 'high',
    agentA: GABRIEL,
    agentB: ALICE,
    filePaths: ['src/app.ts'],
    description: `Test conflict ${id}`,
    resolved,
    detectedAt: isoTimestamp(),
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let store: Store;
let bus: EventBus;
let detector: ConflictDetector;
let emitted: ServerMessage[];

beforeEach(() => {
  store = new Store(':memory:');
  bus = new EventBus();
  detector = new ConflictDetector(store, bus);
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
// Queries
// ---------------------------------------------------------------------------

describe('get', () => {
  it('returns a conflict by ID', () => {
    const conflict = makeConflict('conflict-01');
    store.insertConflict(conflict);

    expect(detector.get(conflictId('conflict-01'))).toEqual(conflict);
  });

  it('returns undefined for non-existent ID', () => {
    expect(detector.get(conflictId('nope'))).toBeUndefined();
  });
});

describe('getAll', () => {
  it('returns all conflicts', () => {
    store.insertConflict(makeConflict('c1'));
    store.insertConflict(makeConflict('c2', true)); // resolved

    expect(detector.getAll()).toHaveLength(2);
  });

  it('returns empty array when no conflicts', () => {
    expect(detector.getAll()).toHaveLength(0);
  });
});

describe('getUnresolved', () => {
  it('returns only unresolved conflicts', () => {
    store.insertConflict(makeConflict('c1'));
    store.insertConflict(makeConflict('c2', true)); // resolved
    store.insertConflict(makeConflict('c3'));

    const unresolved = detector.getUnresolved();
    expect(unresolved).toHaveLength(2);
    expect(unresolved.every((c) => !c.resolved)).toBe(true);
  });

  it('returns empty array when all resolved', () => {
    store.insertConflict(makeConflict('c1', true));
    expect(detector.getUnresolved()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe('resolve', () => {
  it('marks a conflict as resolved', () => {
    store.insertConflict(makeConflict('c1'));

    const resolved = detector.resolve(conflictId('c1'));

    expect(resolved).toBe(true);
    expect(store.getConflict(conflictId('c1'))?.resolved).toBe(true);
  });

  it('returns false for non-existent conflict', () => {
    expect(detector.resolve(conflictId('nope'))).toBe(false);
  });

  it('returns false for already resolved conflict', () => {
    store.insertConflict(makeConflict('c1', true));
    expect(detector.resolve(conflictId('c1'))).toBe(false);
  });

  it('emits conflict_resolved event', () => {
    store.insertConflict(makeConflict('c1'));

    detector.resolve(conflictId('c1'));

    const resolveEvents = emitted.filter((e) => e.type === 'conflict_resolved');
    expect(resolveEvents).toHaveLength(1);
  });

  it('does not emit event for non-existent conflict', () => {
    detector.resolve(conflictId('nope'));
    expect(emitted).toHaveLength(0);
  });

  it('does not emit event for already resolved conflict', () => {
    store.insertConflict(makeConflict('c1', true));
    detector.resolve(conflictId('c1'));
    expect(emitted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Utility methods
// ---------------------------------------------------------------------------

describe('hasUnresolved', () => {
  it('returns false when no conflicts', () => {
    expect(detector.hasUnresolved()).toBe(false);
  });

  it('returns true when unresolved conflicts exist', () => {
    store.insertConflict(makeConflict('c1'));
    expect(detector.hasUnresolved()).toBe(true);
  });

  it('returns false when all conflicts are resolved', () => {
    store.insertConflict(makeConflict('c1', true));
    expect(detector.hasUnresolved()).toBe(false);
  });
});

describe('unresolvedCount', () => {
  it('returns 0 when no conflicts', () => {
    expect(detector.unresolvedCount()).toBe(0);
  });

  it('counts only unresolved conflicts', () => {
    store.insertConflict(makeConflict('c1'));
    store.insertConflict(makeConflict('c2'));
    store.insertConflict(makeConflict('c3', true));

    expect(detector.unresolvedCount()).toBe(2);
  });

  it('updates after resolution', () => {
    store.insertConflict(makeConflict('c1'));
    store.insertConflict(makeConflict('c2'));
    expect(detector.unresolvedCount()).toBe(2);

    detector.resolve(conflictId('c1'));
    expect(detector.unresolvedCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('scenarios', () => {
  it('multiple conflicts raised and resolved one by one', () => {
    store.insertConflict(makeConflict('c1'));
    store.insertConflict(makeConflict('c2'));
    store.insertConflict(makeConflict('c3'));

    expect(detector.unresolvedCount()).toBe(3);

    detector.resolve(conflictId('c1'));
    expect(detector.unresolvedCount()).toBe(2);

    detector.resolve(conflictId('c2'));
    expect(detector.unresolvedCount()).toBe(1);

    detector.resolve(conflictId('c3'));
    expect(detector.unresolvedCount()).toBe(0);
    expect(detector.hasUnresolved()).toBe(false);
  });

  it('mixed conflict types', () => {
    store.insertConflict({
      ...makeConflict('c-file'),
      type: 'file_contention',
    });
    store.insertConflict({
      ...makeConflict('c-decision'),
      type: 'decision_contradiction',
    });
    store.insertConflict({
      ...makeConflict('c-task'),
      type: 'task_overlap',
    });

    const all = detector.getAll();
    expect(all).toHaveLength(3);

    const types = all.map((c) => c.type);
    expect(types).toContain('file_contention');
    expect(types).toContain('decision_contradiction');
    expect(types).toContain('task_overlap');
  });
});
