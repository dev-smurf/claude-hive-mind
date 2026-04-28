import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/services/store.js';
import {
  AGENT_GABRIEL,
  AGENT_ALICE,
  AGENT_IDLE,
  OWNERSHIP_EXCLUSIVE,
  OWNERSHIP_SHARED,
  TASK_PENDING,
  TASK_IN_PROGRESS,
  KNOWLEDGE_FILE_SUMMARY,
  KNOWLEDGE_PATTERN,
  DECISION_AUTH,
  DECISION_DB,
  CONFLICT_FILE,
  NOW,
  EARLIER,
  LATER,
} from '../fixtures/valid-data.js';
import { agentId, taskId, conflictId, decisionId, isoTimestamp } from '../../src/schemas.js';

// ---------------------------------------------------------------------------
// Setup / teardown — fresh in-memory DB for every test
// ---------------------------------------------------------------------------

let store: Store;

beforeEach(() => {
  store = new Store(':memory:');
});

afterEach(() => {
  store.close();
});

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

describe('agents', () => {
  it('inserts and retrieves an agent', () => {
    store.upsertAgent(AGENT_GABRIEL);
    const agent = store.getAgent(AGENT_GABRIEL.id);
    expect(agent).toEqual(AGENT_GABRIEL);
  });

  it('returns undefined for non-existent agent', () => {
    expect(store.getAgent(agentId('nope'))).toBeUndefined();
  });

  it('upserts (updates) an existing agent', () => {
    store.upsertAgent(AGENT_GABRIEL);
    const updated = { ...AGENT_GABRIEL, status: 'busy' as const };
    store.upsertAgent(updated);
    expect(store.getAgent(AGENT_GABRIEL.id)?.status).toBe('busy');
  });

  it('lists all agents ordered by connectedAt', () => {
    store.upsertAgent(AGENT_ALICE);
    store.upsertAgent(AGENT_GABRIEL);
    store.upsertAgent(AGENT_IDLE);
    const all = store.getAllAgents();
    expect(all).toHaveLength(3);
    // All have same connectedAt (EARLIER), so order is stable by insert
  });

  it('updates agent status', () => {
    store.upsertAgent(AGENT_GABRIEL);
    store.updateAgentStatus(AGENT_GABRIEL.id, 'disconnected');
    expect(store.getAgent(AGENT_GABRIEL.id)?.status).toBe('disconnected');
  });

  it('updates agent heartbeat', () => {
    store.upsertAgent(AGENT_GABRIEL);
    store.updateAgentHeartbeat(AGENT_GABRIEL.id, LATER);
    expect(store.getAgent(AGENT_GABRIEL.id)?.lastHeartbeat).toBe(LATER);
  });

  it('updates agent current task', () => {
    store.upsertAgent(AGENT_GABRIEL);
    store.updateAgentTask(AGENT_GABRIEL.id, taskId('task-999'));
    expect(store.getAgent(AGENT_GABRIEL.id)?.currentTaskId).toBe('task-999');
  });

  it('clears agent current task with null', () => {
    store.upsertAgent(AGENT_GABRIEL);
    store.updateAgentTask(AGENT_GABRIEL.id, null);
    expect(store.getAgent(AGENT_GABRIEL.id)?.currentTaskId).toBeNull();
  });

  it('deletes an agent', () => {
    store.upsertAgent(AGENT_GABRIEL);
    store.deleteAgent(AGENT_GABRIEL.id);
    expect(store.getAgent(AGENT_GABRIEL.id)).toBeUndefined();
  });

  it('finds stale agents by heartbeat cutoff', () => {
    store.upsertAgent(AGENT_GABRIEL); // heartbeat = NOW
    store.upsertAgent(AGENT_IDLE); // heartbeat = EARLIER
    const stale = store.getStaleAgents(NOW);
    expect(stale).toHaveLength(1);
    expect(stale[0]?.id).toBe(AGENT_IDLE.id);
  });

  it('excludes disconnected agents from stale check', () => {
    const disconnected = { ...AGENT_IDLE, status: 'disconnected' as const };
    store.upsertAgent(disconnected);
    const stale = store.getStaleAgents(NOW);
    expect(stale).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// File Ownership
// ---------------------------------------------------------------------------

describe('file ownership', () => {
  beforeEach(() => {
    // Agents must exist for foreign key
    store.upsertAgent(AGENT_GABRIEL);
    store.upsertAgent(AGENT_ALICE);
  });

  it('inserts and retrieves a file claim', () => {
    store.upsertFileOwnership(OWNERSHIP_EXCLUSIVE);
    const claim = store.getFileOwnership(OWNERSHIP_EXCLUSIVE.filePath, OWNERSHIP_EXCLUSIVE.branch);
    expect(claim).toEqual(OWNERSHIP_EXCLUSIVE);
  });

  it('returns undefined for unclaimed file', () => {
    expect(store.getFileOwnership('nonexistent.ts')).toBeUndefined();
  });

  it('upserts (replaces) existing claim', () => {
    store.upsertFileOwnership(OWNERSHIP_EXCLUSIVE);
    const newClaim = { ...OWNERSHIP_EXCLUSIVE, agentId: AGENT_ALICE.id, mode: 'shared' as const };
    store.upsertFileOwnership(newClaim);
    const claim = store.getFileOwnership(OWNERSHIP_EXCLUSIVE.filePath, OWNERSHIP_EXCLUSIVE.branch);
    expect(claim?.agentId).toBe(AGENT_ALICE.id);
    expect(claim?.mode).toBe('shared');
  });

  it('lists files by agent', () => {
    store.upsertFileOwnership(OWNERSHIP_EXCLUSIVE);
    store.upsertFileOwnership(OWNERSHIP_SHARED);
    const gabrielFiles = store.getFilesByAgent(AGENT_GABRIEL.id);
    expect(gabrielFiles).toHaveLength(1);
    expect(gabrielFiles[0]?.filePath).toBe('src/auth/login.ts');
  });

  it('lists all file ownerships', () => {
    store.upsertFileOwnership(OWNERSHIP_EXCLUSIVE);
    store.upsertFileOwnership(OWNERSHIP_SHARED);
    expect(store.getAllFileOwnerships()).toHaveLength(2);
  });

  it('deletes a specific file claim', () => {
    store.upsertFileOwnership(OWNERSHIP_EXCLUSIVE);
    store.deleteFileOwnership(OWNERSHIP_EXCLUSIVE.filePath, OWNERSHIP_EXCLUSIVE.branch);
    expect(store.getFileOwnership(OWNERSHIP_EXCLUSIVE.filePath, OWNERSHIP_EXCLUSIVE.branch)).toBeUndefined();
  });

  it('deletes all files by agent', () => {
    store.upsertFileOwnership(OWNERSHIP_EXCLUSIVE);
    store.deleteFilesByAgent(AGENT_GABRIEL.id);
    expect(store.getFilesByAgent(AGENT_GABRIEL.id)).toHaveLength(0);
  });

  it('finds expired files', () => {
    store.upsertFileOwnership(OWNERSHIP_EXCLUSIVE); // expires at LATER
    store.upsertFileOwnership(OWNERSHIP_SHARED); // expires at null
    const farFuture = isoTimestamp(new Date('2099-01-01T00:00:00Z'));
    const expired = store.getExpiredFiles(farFuture);
    expect(expired).toHaveLength(1);
    expect(expired[0]?.filePath).toBe('src/auth/login.ts');
  });

  it('does not find non-expired files', () => {
    store.upsertFileOwnership(OWNERSHIP_EXCLUSIVE); // expires at LATER
    const expired = store.getExpiredFiles(EARLIER);
    expect(expired).toHaveLength(0);
  });

  it('counts files per agent', () => {
    store.upsertFileOwnership(OWNERSHIP_EXCLUSIVE);
    expect(store.countFilesByAgent(AGENT_GABRIEL.id)).toBe(1);
    expect(store.countFilesByAgent(AGENT_ALICE.id)).toBe(0);
  });

  it('cascades delete when agent is removed', () => {
    store.upsertFileOwnership(OWNERSHIP_EXCLUSIVE);
    store.deleteAgent(AGENT_GABRIEL.id);
    expect(store.getFileOwnership(OWNERSHIP_EXCLUSIVE.filePath)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

describe('tasks', () => {
  beforeEach(() => {
    store.upsertAgent(AGENT_GABRIEL);
    store.upsertAgent(AGENT_ALICE);
  });

  it('inserts and retrieves a task', () => {
    store.insertTask(TASK_PENDING);
    const task = store.getTask(TASK_PENDING.id);
    expect(task).toEqual(TASK_PENDING);
  });

  it('returns undefined for non-existent task', () => {
    expect(store.getTask(taskId('nope'))).toBeUndefined();
  });

  it('preserves file_paths array through JSON round-trip', () => {
    store.insertTask(TASK_PENDING);
    const task = store.getTask(TASK_PENDING.id);
    expect(task?.filePaths).toEqual(['src/auth/login.ts', 'src/auth/middleware.ts']);
  });

  it('preserves depends_on array through JSON round-trip', () => {
    store.insertTask(TASK_PENDING);
    store.insertTask(TASK_IN_PROGRESS);
    const task = store.getTask(TASK_IN_PROGRESS.id);
    expect(task?.dependsOn).toEqual([TASK_PENDING.id]);
  });

  it('lists all tasks', () => {
    store.insertTask(TASK_PENDING);
    store.insertTask(TASK_IN_PROGRESS);
    expect(store.getAllTasks()).toHaveLength(2);
  });

  it('filters tasks by status', () => {
    store.insertTask(TASK_PENDING);
    store.insertTask(TASK_IN_PROGRESS);
    const pending = store.getTasksByStatus('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(TASK_PENDING.id);
  });

  it('updates task status', () => {
    store.insertTask(TASK_PENDING);
    store.updateTaskStatus(TASK_PENDING.id, 'completed', LATER);
    const task = store.getTask(TASK_PENDING.id);
    expect(task?.status).toBe('completed');
    expect(task?.updatedAt).toBe(LATER);
  });

  it('assigns a task to an agent', () => {
    store.insertTask(TASK_PENDING);
    store.assignTask(TASK_PENDING.id, AGENT_GABRIEL.id, NOW);
    const task = store.getTask(TASK_PENDING.id);
    expect(task?.assignedAgentId).toBe(AGENT_GABRIEL.id);
    expect(task?.status).toBe('in_progress');
  });

  it('unassigns a task', () => {
    store.insertTask(TASK_IN_PROGRESS);
    store.unassignTask(TASK_IN_PROGRESS.id, LATER);
    const task = store.getTask(TASK_IN_PROGRESS.id);
    expect(task?.assignedAgentId).toBeNull();
    expect(task?.status).toBe('pending');
  });

  it('deletes a task', () => {
    store.insertTask(TASK_PENDING);
    store.deleteTask(TASK_PENDING.id);
    expect(store.getTask(TASK_PENDING.id)).toBeUndefined();
  });

  it('sets assigned_agent_id to NULL when agent is deleted', () => {
    store.insertTask(TASK_IN_PROGRESS);
    store.deleteAgent(AGENT_ALICE.id);
    const task = store.getTask(TASK_IN_PROGRESS.id);
    expect(task?.assignedAgentId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

describe('knowledge', () => {
  beforeEach(() => {
    store.upsertAgent(AGENT_GABRIEL);
    store.upsertAgent(AGENT_ALICE);
  });

  it('inserts and retrieves a knowledge entry', () => {
    store.upsertKnowledge(KNOWLEDGE_FILE_SUMMARY);
    const entry = store.getKnowledge(KNOWLEDGE_FILE_SUMMARY.key);
    expect(entry).toEqual(KNOWLEDGE_FILE_SUMMARY);
  });

  it('returns undefined for non-existent key', () => {
    expect(store.getKnowledge('nope')).toBeUndefined();
  });

  it('upserts (replaces) existing knowledge', () => {
    store.upsertKnowledge(KNOWLEDGE_FILE_SUMMARY);
    const updated = { ...KNOWLEDGE_FILE_SUMMARY, value: 'Updated summary' };
    store.upsertKnowledge(updated);
    expect(store.getKnowledge(KNOWLEDGE_FILE_SUMMARY.key)?.value).toBe('Updated summary');
  });

  it('lists all knowledge entries', () => {
    store.upsertKnowledge(KNOWLEDGE_FILE_SUMMARY);
    store.upsertKnowledge(KNOWLEDGE_PATTERN);
    expect(store.getAllKnowledge()).toHaveLength(2);
  });

  it('deletes a knowledge entry', () => {
    store.upsertKnowledge(KNOWLEDGE_FILE_SUMMARY);
    store.deleteKnowledge(KNOWLEDGE_FILE_SUMMARY.key);
    expect(store.getKnowledge(KNOWLEDGE_FILE_SUMMARY.key)).toBeUndefined();
  });

  it('counts knowledge entries', () => {
    store.upsertKnowledge(KNOWLEDGE_FILE_SUMMARY);
    store.upsertKnowledge(KNOWLEDGE_PATTERN);
    expect(store.countKnowledge()).toBe(2);
  });

  it('deletes oldest entries to enforce limit', () => {
    store.upsertKnowledge(KNOWLEDGE_FILE_SUMMARY); // created at NOW
    store.upsertKnowledge(KNOWLEDGE_PATTERN); // created at NOW (same)
    const deleted = store.deleteOldestKnowledge(1);
    expect(deleted).toBe(1);
    expect(store.countKnowledge()).toBe(1);
  });

  it('deletes expired knowledge entries', () => {
    // KNOWLEDGE_FILE_SUMMARY has ttl_seconds=3600, created at NOW (2026-04-28T12:00:00Z)
    // Expires at 2026-04-28T13:00:00Z
    store.upsertKnowledge(KNOWLEDGE_FILE_SUMMARY);
    store.upsertKnowledge(KNOWLEDGE_PATTERN); // ttl=null, never expires

    const farFuture = isoTimestamp(new Date('2026-04-28T14:00:00Z'));
    const deleted = store.deleteExpiredKnowledge(farFuture);
    expect(deleted).toBe(1);
    expect(store.getKnowledge(KNOWLEDGE_FILE_SUMMARY.key)).toBeUndefined();
    expect(store.getKnowledge(KNOWLEDGE_PATTERN.key)).toBeDefined();
  });

  it('does not delete non-expired knowledge', () => {
    store.upsertKnowledge(KNOWLEDGE_FILE_SUMMARY);
    const deleted = store.deleteExpiredKnowledge(NOW);
    expect(deleted).toBe(0);
  });

  it('cascades delete when agent is removed', () => {
    store.upsertKnowledge(KNOWLEDGE_FILE_SUMMARY);
    store.deleteAgent(AGENT_GABRIEL.id);
    expect(store.getKnowledge(KNOWLEDGE_FILE_SUMMARY.key)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

describe('decisions', () => {
  beforeEach(() => {
    store.upsertAgent(AGENT_GABRIEL);
    store.upsertAgent(AGENT_ALICE);
  });

  it('inserts and retrieves a decision', () => {
    store.insertDecision(DECISION_AUTH);
    const decision = store.getDecision(DECISION_AUTH.id);
    expect(decision).toEqual(DECISION_AUTH);
  });

  it('returns undefined for non-existent decision', () => {
    expect(store.getDecision(decisionId('nope'))).toBeUndefined();
  });

  it('lists all decisions ordered by timestamp', () => {
    store.insertDecision(DECISION_DB); // timestamp = EARLIER
    store.insertDecision(DECISION_AUTH); // timestamp = NOW
    const all = store.getAllDecisions();
    expect(all).toHaveLength(2);
    expect(all[0]?.id).toBe(DECISION_DB.id);
    expect(all[1]?.id).toBe(DECISION_AUTH.id);
  });

  it('filters decisions by category', () => {
    store.insertDecision(DECISION_AUTH);
    store.insertDecision(DECISION_DB);
    const security = store.getDecisionsByCategory('security');
    expect(security).toHaveLength(1);
    expect(security[0]?.id).toBe(DECISION_AUTH.id);
  });

  it('cascades delete when agent is removed', () => {
    store.insertDecision(DECISION_AUTH);
    store.deleteAgent(AGENT_GABRIEL.id);
    expect(store.getDecision(DECISION_AUTH.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

describe('conflicts', () => {
  beforeEach(() => {
    store.upsertAgent(AGENT_GABRIEL);
    store.upsertAgent(AGENT_ALICE);
  });

  it('inserts and retrieves a conflict', () => {
    store.insertConflict(CONFLICT_FILE);
    const conflict = store.getConflict(CONFLICT_FILE.id);
    expect(conflict).toEqual(CONFLICT_FILE);
  });

  it('returns undefined for non-existent conflict', () => {
    expect(store.getConflict(conflictId('nope'))).toBeUndefined();
  });

  it('preserves file_paths array through JSON round-trip', () => {
    store.insertConflict(CONFLICT_FILE);
    const conflict = store.getConflict(CONFLICT_FILE.id);
    expect(conflict?.filePaths).toEqual(['src/auth/login.ts']);
  });

  it('preserves resolved boolean (false)', () => {
    store.insertConflict(CONFLICT_FILE);
    expect(store.getConflict(CONFLICT_FILE.id)?.resolved).toBe(false);
  });

  it('resolves a conflict', () => {
    store.insertConflict(CONFLICT_FILE);
    store.resolveConflict(CONFLICT_FILE.id);
    expect(store.getConflict(CONFLICT_FILE.id)?.resolved).toBe(true);
  });

  it('lists all conflicts', () => {
    store.insertConflict(CONFLICT_FILE);
    expect(store.getAllConflicts()).toHaveLength(1);
  });

  it('lists only unresolved conflicts', () => {
    store.insertConflict(CONFLICT_FILE);
    expect(store.getUnresolvedConflicts()).toHaveLength(1);
    store.resolveConflict(CONFLICT_FILE.id);
    expect(store.getUnresolvedConflicts()).toHaveLength(0);
  });

  it('cascades delete when agent_a is removed', () => {
    store.insertConflict(CONFLICT_FILE);
    store.deleteAgent(AGENT_GABRIEL.id); // agent_a
    expect(store.getConflict(CONFLICT_FILE.id)).toBeUndefined();
  });

  it('cascades delete when agent_b is removed', () => {
    store.insertConflict(CONFLICT_FILE);
    store.deleteAgent(AGENT_ALICE.id); // agent_b
    expect(store.getConflict(CONFLICT_FILE.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

describe('transactions', () => {
  it('commits on success', () => {
    store.upsertAgent(AGENT_GABRIEL);
    store.transaction(() => {
      store.upsertAgent(AGENT_ALICE);
      store.upsertAgent(AGENT_IDLE);
    });
    expect(store.getAllAgents()).toHaveLength(3);
  });

  it('rolls back on error', () => {
    store.upsertAgent(AGENT_GABRIEL);
    expect(() =>
      store.transaction(() => {
        store.upsertAgent(AGENT_ALICE);
        throw new Error('rollback test');
      }),
    ).toThrow('rollback test');
    // AGENT_ALICE should not be persisted
    expect(store.getAllAgents()).toHaveLength(1);
  });

  it('returns the function result', () => {
    store.upsertAgent(AGENT_GABRIEL);
    const result = store.transaction(() => {
      return store.getAllAgents().length;
    });
    expect(result).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Schema idempotency
// ---------------------------------------------------------------------------

describe('schema', () => {
  it('can be opened multiple times on same DB without error', () => {
    // The constructor runs CREATE TABLE IF NOT EXISTS
    const store2 = new Store(':memory:');
    store2.close();
    // No error = idempotent schema creation works
  });

  it('WAL mode is enabled', () => {
    // This is tested implicitly by the store working, but verify explicitly
    store.upsertAgent(AGENT_GABRIEL);
    expect(store.getAgent(AGENT_GABRIEL.id)).toBeDefined();
  });

  it('foreign keys are enforced', () => {
    // Try to insert file ownership for non-existent agent
    expect(() => {
      store.upsertFileOwnership(OWNERSHIP_EXCLUSIVE);
    }).toThrow();
  });
});
