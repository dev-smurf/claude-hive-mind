/**
 * Conflict detection and resolution management.
 *
 * Conflicts are raised by other services (file-ownership, decision-log)
 * when agents collide. This service provides:
 *
 * - Central query point for all conflicts
 * - Resolution workflow (mark conflicts as resolved)
 * - Event emission for conflict lifecycle
 *
 * Conflict types:
 * - **file_contention**: Two agents want conflicting access to a file
 * - **task_overlap**: Two agents working on overlapping tasks
 * - **decision_contradiction**: Conflicting architectural decisions
 * - **dependency_break**: A change breaks a declared dependency
 *
 * Inspired by:
 * - kevensavard/Claude-Squad: conflict detection on file overlap
 * - disler/observability: conflict broadcast to all sessions
 */

import type { Conflict, ConflictId } from '../types.js';
import type { Store } from './store.js';
import type { EventBus } from './event-bus.js';

export class ConflictDetector {
  private readonly store: Store;
  private readonly bus: EventBus;

  constructor(store: Store, bus: EventBus) {
    this.store = store;
    this.bus = bus;
  }

  /** Get a single conflict by ID. */
  get(id: ConflictId): Conflict | undefined {
    return this.store.getConflict(id);
  }

  /** Get all conflicts (resolved and unresolved). */
  getAll(): readonly Conflict[] {
    return this.store.getAllConflicts();
  }

  /** Get only unresolved conflicts. */
  getUnresolved(): readonly Conflict[] {
    return this.store.getUnresolvedConflicts();
  }

  /**
   * Mark a conflict as resolved.
   *
   * Returns true if the conflict existed and was unresolved.
   * Returns false if the conflict doesn't exist or was already resolved.
   */
  resolve(id: ConflictId): boolean {
    const conflict = this.store.getConflict(id);
    if (!conflict) return false;
    if (conflict.resolved) return false;

    this.store.resolveConflict(id);
    this.bus.emit({ type: 'conflict_resolved', conflictId: id });

    return true;
  }

  /** Check if there are any unresolved conflicts. */
  hasUnresolved(): boolean {
    return this.store.getUnresolvedConflicts().length > 0;
  }

  /** Count of unresolved conflicts. */
  unresolvedCount(): number {
    return this.store.getUnresolvedConflicts().length;
  }
}
