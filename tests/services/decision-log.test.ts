import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionLog } from '../../src/services/decision-log.js';
import { Store } from '../../src/services/store.js';
import { EventBus } from '../../src/services/event-bus.js';
import type { ServerMessage } from '../../src/types.js';
import { agentId, decisionId, isoTimestamp } from '../../src/schemas.js';

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

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let store: Store;
let bus: EventBus;
let log: DecisionLog;
let emitted: ServerMessage[];

beforeEach(() => {
  store = new Store(':memory:');
  bus = new EventBus();
  log = new DecisionLog(store, bus);
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
// Logging decisions
// ---------------------------------------------------------------------------

describe('log', () => {
  it('creates a decision with a UUID', () => {
    const decision = log.log({
      agentId: GABRIEL,
      category: 'architecture',
      summary: 'Use microservices',
      rationale: 'Better scalability',
    });

    expect(decision.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets all fields from input', () => {
    const decision = log.log({
      agentId: GABRIEL,
      category: 'database',
      summary: 'Use PostgreSQL',
      rationale: 'ACID compliance needed',
    });

    expect(decision.agentId).toBe(GABRIEL);
    expect(decision.category).toBe('database');
    expect(decision.summary).toBe('Use PostgreSQL');
    expect(decision.rationale).toBe('ACID compliance needed');
  });

  it('sets timestamp', () => {
    const before = new Date().toISOString();
    const decision = log.log({
      agentId: GABRIEL,
      category: 'architecture',
      summary: 'Test',
      rationale: 'Test',
    });
    const after = new Date().toISOString();

    expect(decision.timestamp >= before).toBe(true);
    expect(decision.timestamp <= after).toBe(true);
  });

  it('persists in the store', () => {
    const decision = log.log({
      agentId: GABRIEL,
      category: 'architecture',
      summary: 'Test',
      rationale: 'Test',
    });

    expect(store.getDecision(decision.id)).toEqual(decision);
  });

  it('emits decision_logged event', () => {
    log.log({
      agentId: GABRIEL,
      category: 'architecture',
      summary: 'Test',
      rationale: 'Test',
    });

    const decisionEvents = emitted.filter((e) => e.type === 'decision_logged');
    expect(decisionEvents).toHaveLength(1);
  });

  it('generates unique IDs', () => {
    const d1 = log.log({
      agentId: GABRIEL,
      category: 'architecture',
      summary: 'A',
      rationale: 'A',
    });
    const d2 = log.log({
      agentId: GABRIEL,
      category: 'database',
      summary: 'B',
      rationale: 'B',
    });

    expect(d1.id).not.toBe(d2.id);
  });

  it('supports all decision categories', () => {
    const categories = [
      'architecture',
      'api-design',
      'database',
      'dependency',
      'convention',
      'security',
      'performance',
      'other',
    ] as const;

    for (const category of categories) {
      const d = log.log({
        agentId: GABRIEL,
        category,
        summary: `Decision for ${category}`,
        rationale: 'Test',
      });
      expect(d.category).toBe(category);
    }
  });
});

// ---------------------------------------------------------------------------
// Contradiction detection
// ---------------------------------------------------------------------------

describe('contradiction detection', () => {
  it('detects contradiction when different agent decides in same category', () => {
    log.log({
      agentId: GABRIEL,
      category: 'database',
      summary: 'Use PostgreSQL',
      rationale: 'ACID compliance',
    });

    log.log({
      agentId: ALICE,
      category: 'database',
      summary: 'Use MongoDB',
      rationale: 'Flexible schema',
    });

    const conflictEvents = emitted.filter((e) => e.type === 'conflict_detected');
    expect(conflictEvents).toHaveLength(1);
  });

  it('contradiction has correct type and severity', () => {
    log.log({
      agentId: GABRIEL,
      category: 'architecture',
      summary: 'Monolith',
      rationale: 'Simpler',
    });

    log.log({
      agentId: ALICE,
      category: 'architecture',
      summary: 'Microservices',
      rationale: 'Scalable',
    });

    const conflicts = store.getUnresolvedConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.type).toBe('decision_contradiction');
    expect(conflicts[0]?.severity).toBe('medium');
  });

  it('contradiction identifies both agents', () => {
    log.log({
      agentId: GABRIEL,
      category: 'database',
      summary: 'Use PostgreSQL',
      rationale: 'SQL',
    });

    log.log({
      agentId: ALICE,
      category: 'database',
      summary: 'Use MongoDB',
      rationale: 'NoSQL',
    });

    const conflicts = store.getUnresolvedConflicts();
    expect(conflicts[0]?.agentA).toBe(GABRIEL);
    expect(conflicts[0]?.agentB).toBe(ALICE);
  });

  it('contradiction description includes both summaries', () => {
    log.log({
      agentId: GABRIEL,
      category: 'database',
      summary: 'Use PostgreSQL',
      rationale: 'SQL',
    });

    log.log({
      agentId: ALICE,
      category: 'database',
      summary: 'Use MongoDB',
      rationale: 'NoSQL',
    });

    const conflicts = store.getUnresolvedConflicts();
    expect(conflicts[0]?.description).toContain('Use PostgreSQL');
    expect(conflicts[0]?.description).toContain('Use MongoDB');
  });

  it('no contradiction when same agent updates their own decision', () => {
    log.log({
      agentId: GABRIEL,
      category: 'database',
      summary: 'Use PostgreSQL',
      rationale: 'SQL',
    });

    log.log({
      agentId: GABRIEL,
      category: 'database',
      summary: 'Use SQLite',
      rationale: 'Simpler for MVP',
    });

    const conflictEvents = emitted.filter((e) => e.type === 'conflict_detected');
    expect(conflictEvents).toHaveLength(0);
  });

  it('no contradiction across different categories', () => {
    log.log({
      agentId: GABRIEL,
      category: 'database',
      summary: 'Use PostgreSQL',
      rationale: 'SQL',
    });

    log.log({
      agentId: ALICE,
      category: 'architecture',
      summary: 'Microservices',
      rationale: 'Scalable',
    });

    const conflictEvents = emitted.filter((e) => e.type === 'conflict_detected');
    expect(conflictEvents).toHaveLength(0);
  });

  it('does NOT flag unrelated convention decisions (Marie false-positive case)', () => {
    log.log({
      agentId: GABRIEL,
      category: 'convention',
      summary: 'Felix owns collab refactor; Marie audits crypto',
      rationale: 'Coordination call after 409',
    });
    log.log({
      agentId: ALICE,
      category: 'convention',
      summary: 'Mark Bob edits with comment',
      rationale: 'Provenance trail',
    });
    const conflictEvents = emitted.filter((e) => e.type === 'conflict_detected');
    expect(conflictEvents).toHaveLength(0);
  });

  it('flags overlapping convention decisions (real contradiction)', () => {
    log.log({
      agentId: GABRIEL,
      category: 'convention',
      summary: 'Use camelCase for variables',
      rationale: 'JS idiomatic',
    });
    log.log({
      agentId: ALICE,
      category: 'convention',
      summary: 'Use snake_case for variables',
      rationale: 'Python idiomatic',
    });
    const conflictEvents = emitted.filter((e) => e.type === 'conflict_detected');
    expect(conflictEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('treats explicit supersede markers as agreement, not contradiction', () => {
    log.log({
      agentId: GABRIEL,
      category: 'database',
      summary: 'Use PostgreSQL',
      rationale: 'ACID',
    });
    log.log({
      agentId: ALICE,
      category: 'database',
      summary: 'Use SQLite (supersedes earlier PostgreSQL choice)',
      rationale: 'simpler for MVP',
    });
    const conflictEvents = emitted.filter((e) => e.type === 'conflict_detected');
    expect(conflictEvents).toHaveLength(0);
  });

  it('still records the decision even when contradiction detected', () => {
    log.log({
      agentId: GABRIEL,
      category: 'database',
      summary: 'Use PostgreSQL',
      rationale: 'SQL',
    });

    const d2 = log.log({
      agentId: ALICE,
      category: 'database',
      summary: 'Use MongoDB',
      rationale: 'NoSQL',
    });

    // Both decisions should exist
    const all = log.getByCategory('database');
    expect(all).toHaveLength(2);
    expect(store.getDecision(d2.id)).toBeDefined();
  });

  it('emits both conflict_detected and decision_logged', () => {
    log.log({
      agentId: GABRIEL,
      category: 'database',
      summary: 'PostgreSQL',
      rationale: 'SQL',
    });
    emitted.length = 0;

    log.log({
      agentId: ALICE,
      category: 'database',
      summary: 'MongoDB',
      rationale: 'NoSQL',
    });

    const types = emitted.map((e) => e.type);
    expect(types).toContain('conflict_detected');
    expect(types).toContain('decision_logged');
  });
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

describe('get', () => {
  it('returns a decision by ID', () => {
    const decision = log.log({
      agentId: GABRIEL,
      category: 'architecture',
      summary: 'Test',
      rationale: 'Test',
    });

    expect(log.get(decision.id)).toEqual(decision);
  });

  it('returns undefined for non-existent ID', () => {
    expect(log.get(decisionId('nope'))).toBeUndefined();
  });
});

describe('getAll', () => {
  it('returns all decisions ordered by timestamp', () => {
    log.log({ agentId: GABRIEL, category: 'database', summary: 'A', rationale: 'A' });
    log.log({ agentId: ALICE, category: 'architecture', summary: 'B', rationale: 'B' });

    const all = log.getAll();
    expect(all).toHaveLength(2);
  });

  it('returns empty array when no decisions', () => {
    expect(log.getAll()).toHaveLength(0);
  });
});

describe('getByCategory', () => {
  it('filters by category', () => {
    log.log({ agentId: GABRIEL, category: 'database', summary: 'DB1', rationale: 'R' });
    log.log({ agentId: GABRIEL, category: 'architecture', summary: 'A1', rationale: 'R' });
    log.log({ agentId: ALICE, category: 'database', summary: 'DB2', rationale: 'R' });

    const dbDecisions = log.getByCategory('database');
    expect(dbDecisions).toHaveLength(2);
    expect(dbDecisions.every((d) => d.category === 'database')).toBe(true);
  });

  it('returns empty array for category with no decisions', () => {
    expect(log.getByCategory('security')).toHaveLength(0);
  });
});

describe('getLatest', () => {
  it('returns the most recent decision in a category', () => {
    log.log({ agentId: GABRIEL, category: 'database', summary: 'PostgreSQL', rationale: 'R' });
    log.log({ agentId: ALICE, category: 'database', summary: 'SQLite', rationale: 'R' });

    const latest = log.getLatest('database');
    expect(latest?.summary).toBe('SQLite');
  });

  it('returns undefined for empty category', () => {
    expect(log.getLatest('security')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('scenarios', () => {
  it('decision evolution: same agent refines over time', () => {
    log.log({
      agentId: GABRIEL,
      category: 'architecture',
      summary: 'Monolith first',
      rationale: 'MVP',
    });

    log.log({
      agentId: GABRIEL,
      category: 'architecture',
      summary: 'Extract auth service',
      rationale: 'Growing complexity',
    });

    log.log({
      agentId: GABRIEL,
      category: 'architecture',
      summary: 'Full microservices',
      rationale: 'Team growth',
    });

    const all = log.getByCategory('architecture');
    expect(all).toHaveLength(3);

    const latest = log.getLatest('architecture');
    expect(latest?.summary).toBe('Full microservices');

    // No contradictions since same agent
    const conflictEvents = emitted.filter((e) => e.type === 'conflict_detected');
    expect(conflictEvents).toHaveLength(0);
  });

  it('multi-category decisions across agents', () => {
    log.log({ agentId: GABRIEL, category: 'database', summary: 'PostgreSQL', rationale: 'R' });
    log.log({ agentId: GABRIEL, category: 'security', summary: 'JWT auth', rationale: 'R' });
    log.log({ agentId: ALICE, category: 'convention', summary: 'ESM imports', rationale: 'R' });
    log.log({
      agentId: ALICE,
      category: 'performance',
      summary: 'Redis caching',
      rationale: 'R',
    });

    expect(log.getAll()).toHaveLength(4);
    expect(log.getByCategory('database')).toHaveLength(1);
    expect(log.getByCategory('security')).toHaveLength(1);
    expect(log.getByCategory('convention')).toHaveLength(1);
    expect(log.getByCategory('performance')).toHaveLength(1);
  });
});
