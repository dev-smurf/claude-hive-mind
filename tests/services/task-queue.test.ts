import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TaskQueue } from '../../src/services/task-queue.js';
import { Store } from '../../src/services/store.js';
import { EventBus } from '../../src/services/event-bus.js';
import type { ServerMessage } from '../../src/types.js';
import { agentId, taskId, isoTimestamp } from '../../src/schemas.js';

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
let queue: TaskQueue;
let emitted: ServerMessage[];

beforeEach(() => {
  store = new Store(':memory:');
  bus = new EventBus();
  queue = new TaskQueue(store, bus);
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
// Task creation
// ---------------------------------------------------------------------------

describe('create', () => {
  it('creates a task with a UUID', () => {
    const task = queue.create({ title: 'Fix bug', description: 'Fix the login bug' });
    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets title and description from input', () => {
    const task = queue.create({ title: 'Fix bug', description: 'Fix the login bug' });
    expect(task.title).toBe('Fix bug');
    expect(task.description).toBe('Fix the login bug');
  });

  it('starts as pending with no agent', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    expect(task.status).toBe('pending');
    expect(task.assignedAgentId).toBeNull();
  });

  it('defaults priority to medium', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    expect(task.priority).toBe('medium');
  });

  it('respects explicit priority', () => {
    const task = queue.create({ title: 'Critical fix', description: '', priority: 'critical' });
    expect(task.priority).toBe('critical');
  });

  it('defaults filePaths to empty', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    expect(task.filePaths).toEqual([]);
  });

  it('accepts filePaths', () => {
    const task = queue.create({
      title: 'Fix bug',
      description: '',
      filePaths: ['src/app.ts', 'src/utils.ts'],
    });
    expect(task.filePaths).toEqual(['src/app.ts', 'src/utils.ts']);
  });

  it('defaults dependsOn to empty', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    expect(task.dependsOn).toEqual([]);
  });

  it('accepts dependencies', () => {
    const dep = queue.create({ title: 'Setup', description: '' });
    const task = queue.create({
      title: 'Build',
      description: '',
      dependsOn: [dep.id],
    });
    expect(task.dependsOn).toEqual([dep.id]);
  });

  it('sets createdAt and updatedAt', () => {
    const before = new Date().toISOString();
    const task = queue.create({ title: 'Fix bug', description: '' });
    const after = new Date().toISOString();

    expect(task.createdAt >= before).toBe(true);
    expect(task.createdAt <= after).toBe(true);
    expect(task.updatedAt).toBe(task.createdAt);
  });

  it('persists in the store', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    expect(store.getTask(task.id)).toEqual(task);
  });

  it('emits task_created event', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({ type: 'task_created', task });
  });

  it('generates unique IDs', () => {
    const t1 = queue.create({ title: 'A', description: '' });
    const t2 = queue.create({ title: 'B', description: '' });
    expect(t1.id).not.toBe(t2.id);
  });
});

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

describe('assign', () => {
  it('assigns a pending task to an agent', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    const assigned = queue.assign(task.id, GABRIEL);

    expect(assigned).not.toBeNull();
    expect(assigned?.status).toBe('in_progress');
    expect(assigned?.assignedAgentId).toBe(GABRIEL);
  });

  it('returns null for non-existent task', () => {
    expect(queue.assign(taskId('nope'), GABRIEL)).toBeNull();
  });

  it('returns null if task is not pending', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    queue.assign(task.id, GABRIEL); // now in_progress

    expect(queue.assign(task.id, ALICE)).toBeNull();
  });

  it('blocks assignment when dependencies are not met', () => {
    const dep = queue.create({ title: 'Setup', description: '' });
    const task = queue.create({
      title: 'Build',
      description: '',
      dependsOn: [dep.id],
    });

    expect(queue.assign(task.id, GABRIEL)).toBeNull();
  });

  it('allows assignment when dependencies are completed', () => {
    const dep = queue.create({ title: 'Setup', description: '' });
    const task = queue.create({
      title: 'Build',
      description: '',
      dependsOn: [dep.id],
    });

    // Complete the dependency
    queue.assign(dep.id, GABRIEL);
    queue.complete(dep.id);

    const assigned = queue.assign(task.id, ALICE);
    expect(assigned).not.toBeNull();
    expect(assigned?.status).toBe('in_progress');
  });

  it('emits task_updated event', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    emitted.length = 0;

    queue.assign(task.id, GABRIEL);

    const updateEvents = emitted.filter((e) => e.type === 'task_updated');
    expect(updateEvents).toHaveLength(1);
  });

  it('updates the updatedAt timestamp', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    const assigned = queue.assign(task.id, GABRIEL);

    // updatedAt should be >= createdAt
    expect(assigned?.updatedAt).not.toBe('');
    expect(assigned != null && assigned.updatedAt >= task.createdAt).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unassignment
// ---------------------------------------------------------------------------

describe('unassign', () => {
  it('returns task to pending status', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    queue.assign(task.id, GABRIEL);

    const unassigned = queue.unassign(task.id);

    expect(unassigned?.status).toBe('pending');
    expect(unassigned?.assignedAgentId).toBeNull();
  });

  it('returns null for non-existent task', () => {
    expect(queue.unassign(taskId('nope'))).toBeNull();
  });

  it('returns null if task is not in_progress', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    expect(queue.unassign(task.id)).toBeNull(); // pending, not in_progress
  });

  it('emits task_updated event', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    queue.assign(task.id, GABRIEL);
    emitted.length = 0;

    queue.unassign(task.id);

    const updateEvents = emitted.filter((e) => e.type === 'task_updated');
    expect(updateEvents).toHaveLength(1);
  });

  it('allows re-assignment after unassign', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    queue.assign(task.id, GABRIEL);
    queue.unassign(task.id);

    const reassigned = queue.assign(task.id, ALICE);
    expect(reassigned?.assignedAgentId).toBe(ALICE);
  });
});

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

describe('complete', () => {
  it('marks in_progress task as completed', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    queue.assign(task.id, GABRIEL);

    const completed = queue.complete(task.id);

    expect(completed?.status).toBe('completed');
  });

  it('returns null for pending task', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    expect(queue.complete(task.id)).toBeNull();
  });

  it('returns null for non-existent task', () => {
    expect(queue.complete(taskId('nope'))).toBeNull();
  });

  it('emits task_updated event', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    queue.assign(task.id, GABRIEL);
    emitted.length = 0;

    queue.complete(task.id);

    const updateEvents = emitted.filter((e) => e.type === 'task_updated');
    expect(updateEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

describe('fail', () => {
  it('marks in_progress task as failed', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    queue.assign(task.id, GABRIEL);

    const failed = queue.fail(task.id);

    expect(failed?.status).toBe('failed');
  });

  it('returns null for pending task', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    expect(queue.fail(task.id)).toBeNull();
  });

  it('returns null for non-existent task', () => {
    expect(queue.fail(taskId('nope'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe('cancel', () => {
  it('cancels a pending task', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    const cancelled = queue.cancel(task.id);

    expect(cancelled?.status).toBe('cancelled');
  });

  it('cancels an in_progress task', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    queue.assign(task.id, GABRIEL);

    const cancelled = queue.cancel(task.id);
    expect(cancelled?.status).toBe('cancelled');
  });

  it('returns null for completed task', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    queue.assign(task.id, GABRIEL);
    queue.complete(task.id);

    expect(queue.cancel(task.id)).toBeNull();
  });

  it('returns null for non-existent task', () => {
    expect(queue.cancel(taskId('nope'))).toBeNull();
  });

  it('emits task_updated event', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    emitted.length = 0;

    queue.cancel(task.id);

    const updateEvents = emitted.filter((e) => e.type === 'task_updated');
    expect(updateEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Next available
// ---------------------------------------------------------------------------

describe('getNextAvailable', () => {
  it('returns null when no tasks exist', () => {
    expect(queue.getNextAvailable()).toBeNull();
  });

  it('returns null when no pending tasks', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    queue.assign(task.id, GABRIEL);
    expect(queue.getNextAvailable()).toBeNull();
  });

  it('returns the highest-priority pending task', () => {
    queue.create({ title: 'Low', description: '', priority: 'low' });
    queue.create({ title: 'Critical', description: '', priority: 'critical' });
    queue.create({ title: 'High', description: '', priority: 'high' });

    const next = queue.getNextAvailable();
    expect(next?.title).toBe('Critical');
  });

  it('skips tasks with unmet dependencies', () => {
    const dep = queue.create({ title: 'Setup', description: '' });
    // Assign the dep so it's no longer in the pending pool
    queue.assign(dep.id, GABRIEL);

    queue.create({
      title: 'Build (blocked)',
      description: '',
      priority: 'critical',
      dependsOn: [dep.id],
    });
    queue.create({ title: 'Test (available)', description: '', priority: 'medium' });

    const next = queue.getNextAvailable();
    // Build is critical but blocked — Test is the only available task
    expect(next?.title).toBe('Test (available)');
  });

  it('returns task with met dependencies', () => {
    const dep = queue.create({ title: 'Setup', description: '' });
    queue.create({
      title: 'Build',
      description: '',
      priority: 'high',
      dependsOn: [dep.id],
    });

    // Complete the dependency
    queue.assign(dep.id, GABRIEL);
    queue.complete(dep.id);

    const next = queue.getNextAvailable();
    expect(next?.title).toBe('Build');
  });

  it('falls back to FIFO within the same priority', () => {
    const t1 = queue.create({ title: 'First', description: '', priority: 'medium' });
    queue.create({ title: 'Second', description: '', priority: 'medium' });

    const next = queue.getNextAvailable();
    // Both medium priority — sort is stable, so first created wins
    // (Array.sort is stable in V8 and all modern engines)
    expect(next?.id).toBe(t1.id);
  });
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

describe('getTask', () => {
  it('returns the task if it exists', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    expect(queue.getTask(task.id)).toEqual(task);
  });

  it('returns undefined if not found', () => {
    expect(queue.getTask(taskId('nope'))).toBeUndefined();
  });
});

describe('getAllTasks', () => {
  it('returns empty array when no tasks', () => {
    expect(queue.getAllTasks()).toEqual([]);
  });

  it('returns all tasks regardless of status', () => {
    const t1 = queue.create({ title: 'A', description: '' });
    queue.create({ title: 'B', description: '' });
    queue.assign(t1.id, GABRIEL);
    queue.complete(t1.id);

    expect(queue.getAllTasks()).toHaveLength(2);
  });
});

describe('getTasksByStatus', () => {
  it('filters by status', () => {
    const t1 = queue.create({ title: 'A', description: '' });
    queue.create({ title: 'B', description: '' });
    queue.assign(t1.id, GABRIEL);

    expect(queue.getTasksByStatus('pending')).toHaveLength(1);
    expect(queue.getTasksByStatus('in_progress')).toHaveLength(1);
    expect(queue.getTasksByStatus('completed')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe('delete', () => {
  it('permanently removes a task', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    const deleted = queue.delete(task.id);

    expect(deleted).toBe(true);
    expect(store.getTask(task.id)).toBeUndefined();
  });

  it('returns false for non-existent task', () => {
    expect(queue.delete(taskId('nope'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end lifecycle
// ---------------------------------------------------------------------------

describe('full lifecycle', () => {
  it('create → assign → complete', () => {
    const task = queue.create({ title: 'Fix bug', description: 'Fix login' });
    expect(task.status).toBe('pending');

    const assigned = queue.assign(task.id, GABRIEL);
    expect(assigned?.status).toBe('in_progress');
    expect(assigned?.assignedAgentId).toBe(GABRIEL);

    const completed = queue.complete(task.id);
    expect(completed?.status).toBe('completed');
  });

  it('create → assign → fail', () => {
    const task = queue.create({ title: 'Risky change', description: '' });
    queue.assign(task.id, GABRIEL);
    const failed = queue.fail(task.id);

    expect(failed?.status).toBe('failed');
  });

  it('create → assign → unassign → re-assign', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    queue.assign(task.id, GABRIEL);
    queue.unassign(task.id);

    const reassigned = queue.assign(task.id, ALICE);
    expect(reassigned?.assignedAgentId).toBe(ALICE);
  });

  it('dependency chain: A → B → C', () => {
    const a = queue.create({ title: 'Setup', description: '' });
    const b = queue.create({ title: 'Build', description: '', dependsOn: [a.id] });
    const c = queue.create({ title: 'Deploy', description: '', dependsOn: [b.id] });

    // Can't assign B or C yet
    expect(queue.assign(b.id, GABRIEL)).toBeNull();
    expect(queue.assign(c.id, ALICE)).toBeNull();

    // Complete A → B becomes available
    queue.assign(a.id, GABRIEL);
    queue.complete(a.id);
    expect(queue.assign(b.id, ALICE)).not.toBeNull();

    // Complete B → C becomes available
    queue.complete(b.id);
    expect(queue.assign(c.id, GABRIEL)).not.toBeNull();
  });

  it('tracks all events through lifecycle', () => {
    const task = queue.create({ title: 'Fix bug', description: '' });
    queue.assign(task.id, GABRIEL);
    queue.complete(task.id);

    const types = emitted.map((e) => e.type);
    expect(types).toEqual(['task_created', 'task_updated', 'task_updated']);
  });
});
