/**
 * Shared task queue for coordinating work across agents.
 *
 * Tasks represent units of work that need to be done in the codebase.
 * Any agent can create tasks; agents claim tasks before working on them.
 *
 * Features:
 * - Priority ordering (critical > high > medium > low)
 * - Dependency tracking (DAG — task A must complete before task B)
 * - Assignment management (one agent per task at a time)
 * - Status lifecycle (pending → in_progress → completed/failed/cancelled)
 * - File path association (what files a task will touch)
 *
 * Inspired by:
 * - kevensavard/Claude-Squad: shared task assignment with priority
 * - Continuous-Claude-v3: hierarchical task decomposition
 */

import { randomUUID } from 'node:crypto';
import type { AgentId, Task, TaskId, TaskPriority, TaskStatus } from '../types.js';
import { taskId, isoTimestamp } from '../schemas.js';
import type { Store } from './store.js';
import type { EventBus } from './event-bus.js';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  /** Short description of the task. */
  readonly title: string;
  /** Detailed description with context and acceptance criteria. */
  readonly description: string;
  /** Priority level (defaults to 'medium'). */
  readonly priority?: TaskPriority;
  /** Files this task expects to touch. */
  readonly filePaths?: readonly string[];
  /** Task IDs that must complete before this one starts. */
  readonly dependsOn?: readonly TaskId[];
}

export interface UpdateTaskInput {
  /** New title (if changing). */
  readonly title?: string;
  /** New description (if changing). */
  readonly description?: string;
  /** New priority (if changing). */
  readonly priority?: TaskPriority;
  /** New file paths (if changing). */
  readonly filePaths?: readonly string[];
  /** New dependencies (if changing). */
  readonly dependsOn?: readonly TaskId[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Priority weight for ordering: higher = more urgent. */
const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export class TaskQueue {
  private readonly store: Store;
  private readonly bus: EventBus;

  constructor(store: Store, bus: EventBus) {
    this.store = store;
    this.bus = bus;
  }

  /**
   * Create a new task in the queue.
   * Tasks start as 'pending' with no assigned agent.
   */
  create(input: CreateTaskInput): Task {
    const now = isoTimestamp();
    const task: Task = {
      id: taskId(randomUUID()),
      title: input.title,
      description: input.description,
      assignedAgentId: null,
      status: 'pending',
      priority: input.priority ?? 'medium',
      filePaths: input.filePaths ?? [],
      dependsOn: input.dependsOn ?? [],
      createdAt: now,
      updatedAt: now,
    };

    this.store.insertTask(task);
    this.bus.emit({ type: 'task_created', task });

    return task;
  }

  /**
   * Assign a task to an agent.
   *
   * The task must be 'pending' and have all dependencies satisfied
   * (completed). Returns the updated task or null if assignment fails.
   */
  assign(id: TaskId, agentId: AgentId): Task | null {
    const task = this.store.getTask(id);
    if (!task) return null;
    if (task.status !== 'pending') return null;

    // Check dependencies are satisfied
    if (!this.areDependenciesMet(task)) return null;

    const now = isoTimestamp();
    this.store.assignTask(id, agentId, now);

    const updated = this.store.getTask(id);
    if (updated) {
      this.bus.emit({ type: 'task_updated', task: updated });
    }

    return updated ?? null;
  }

  /**
   * Unassign a task from its current agent.
   * Returns the task to 'pending' status so another agent can claim it.
   */
  unassign(id: TaskId): Task | null {
    const task = this.store.getTask(id);
    if (!task) return null;
    if (task.status !== 'in_progress') return null;

    const now = isoTimestamp();
    this.store.unassignTask(id, now);

    const updated = this.store.getTask(id);
    if (updated) {
      this.bus.emit({ type: 'task_updated', task: updated });
    }

    return updated ?? null;
  }

  /**
   * Mark a task as completed.
   * Only in_progress tasks can be completed.
   */
  complete(id: TaskId): Task | null {
    return this.transition(id, 'in_progress', 'completed');
  }

  /**
   * Mark a task as failed.
   * Only in_progress tasks can fail.
   */
  fail(id: TaskId): Task | null {
    return this.transition(id, 'in_progress', 'failed');
  }

  /**
   * Cancel a task.
   * Pending or in_progress tasks can be cancelled.
   */
  cancel(id: TaskId): Task | null {
    const task = this.store.getTask(id);
    if (!task) return null;
    if (task.status !== 'pending' && task.status !== 'in_progress') return null;

    const now = isoTimestamp();
    this.store.updateTaskStatus(id, 'cancelled', now);

    const updated = this.store.getTask(id);
    if (updated) {
      this.bus.emit({ type: 'task_updated', task: updated });
    }

    return updated ?? null;
  }

  /**
   * Get the next available task for an agent.
   *
   * Returns the highest-priority pending task whose dependencies
   * are all satisfied. Returns null if no tasks are available.
   */
  getNextAvailable(): Task | null {
    const pending = this.store.getTasksByStatus('pending');
    if (pending.length === 0) return null;

    // Filter to tasks with satisfied dependencies, then sort by priority
    const available = pending
      .filter((t) => this.areDependenciesMet(t))
      .sort((a, b) => PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority]);

    return available[0] ?? null;
  }

  /** Get a single task by ID. */
  getTask(id: TaskId): Task | undefined {
    return this.store.getTask(id);
  }

  /** Get all tasks (any status). */
  getAllTasks(): readonly Task[] {
    return this.store.getAllTasks();
  }

  /** Get tasks filtered by status. */
  getTasksByStatus(status: TaskStatus): readonly Task[] {
    return this.store.getTasksByStatus(status);
  }

  /** Delete a task permanently. */
  delete(id: TaskId): boolean {
    const task = this.store.getTask(id);
    if (!task) return false;

    this.store.deleteTask(id);
    return true;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Check if all dependencies of a task are satisfied (completed).
   */
  private areDependenciesMet(task: Task): boolean {
    if (task.dependsOn.length === 0) return true;

    for (const depId of task.dependsOn) {
      const dep = this.store.getTask(depId);
      if (dep?.status !== 'completed') return false;
    }

    return true;
  }

  /**
   * Generic status transition with validation.
   * Returns the updated task or null if the transition is invalid.
   */
  private transition(id: TaskId, requiredStatus: TaskStatus, newStatus: TaskStatus): Task | null {
    const task = this.store.getTask(id);
    if (!task) return null;
    if (task.status !== requiredStatus) return null;

    const now = isoTimestamp();
    this.store.updateTaskStatus(id, newStatus, now);

    const updated = this.store.getTask(id);
    if (updated) {
      this.bus.emit({ type: 'task_updated', task: updated });
    }

    return updated ?? null;
  }
}
