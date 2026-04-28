/**
 * File ownership and conflict detection.
 *
 * Manages file claims — the mechanism that prevents two AI agents
 * from editing the same file at the same time.
 *
 * Ownership modes:
 * - **exclusive**: Only the claiming agent can edit the file. Any
 *   other agent trying to claim it gets a conflict.
 * - **shared**: Multiple agents can hold the file, but they must
 *   coordinate edits (soft lock).
 *
 * Conflict detection is built into the claim flow:
 * - Exclusive + Exclusive → conflict (two agents want sole control)
 * - Exclusive + Shared → conflict (sole vs. shared disagree)
 * - Shared + Shared → allowed (cooperative editing)
 *
 * Claims can have a TTL (auto-expire) or be held indefinitely
 * until manually released or the agent disconnects.
 *
 * Inspired by:
 * - kevensavard/Claude-Squad: file lock per session, conflict on overlap
 * - Continuous-Claude-v3: file_claimed / file_released events
 */

import { randomUUID } from 'node:crypto';
import type { AgentId, Conflict, FileOwnership, OwnershipMode, TaskId } from '../types.js';
import { conflictId, isoTimestamp } from '../schemas.js';
import type { Config } from '../config.js';
import type { Store } from './store.js';
import type { EventBus } from './event-bus.js';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface ClaimInput {
  /** File path to claim (repo-relative or absolute). */
  readonly filePath: string;
  /** Agent requesting the claim. */
  readonly agentId: AgentId;
  /** Exclusive lock or shared access. */
  readonly mode: OwnershipMode;
  /** Optional task association. */
  readonly taskId?: TaskId | null;
  /** Optional TTL in ms (overrides config default). null = no expiry. */
  readonly ttlMs?: number | null;
}

export interface ClaimResult {
  /** Whether the claim was successfully granted. */
  readonly granted: boolean;
  /** The file ownership record (set when granted). */
  readonly ownership: FileOwnership | null;
  /** Conflict detected (set when not granted). */
  readonly conflict: Conflict | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class FileOwnershipService {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly config: Config;

  constructor(store: Store, bus: EventBus, config: Config) {
    this.store = store;
    this.bus = bus;
    this.config = config;
  }

  /**
   * Attempt to claim a file for an agent.
   *
   * If no conflicting ownership exists, the claim is granted immediately.
   * If a conflict is detected, it's recorded and the claim is denied.
   *
   * The entire check-then-write is wrapped in a SQLite transaction to
   * prevent TOCTOU races under concurrent requests.
   */
  claim(input: ClaimInput): ClaimResult {
    return this.store.transaction(() => {
      const existing = this.store.getFileOwnership(input.filePath);

      // If someone else already holds this file, check for conflicts
      if (existing && existing.agentId !== input.agentId) {
        const conflict = this.detectConflict(existing, input);
        if (conflict) {
          this.store.insertConflict(conflict);
          this.bus.emit({ type: 'conflict_detected', conflict });
          return { granted: false, ownership: null, conflict };
        }
      }

      // Check per-agent claim limit
      const currentCount = this.store.countFilesByAgent(input.agentId);
      if (currentCount >= this.config.maxClaimsPerAgent) {
        this.bus.emit({
          type: 'error',
          message: `Agent ${input.agentId} exceeded max file claims (${String(this.config.maxClaimsPerAgent)})`,
        });
        return { granted: false, ownership: null, conflict: null };
      }

      // Build the ownership record
      const now = isoTimestamp();
      const ttlMs = input.ttlMs === undefined ? this.config.defaultClaimTtlMs : input.ttlMs;
      const expiresAt =
        ttlMs != null && ttlMs > 0 ? isoTimestamp(new Date(Date.now() + ttlMs)) : null;

      const ownership: FileOwnership = {
        filePath: input.filePath,
        agentId: input.agentId,
        mode: input.mode,
        taskId: input.taskId ?? null,
        claimedAt: now,
        expiresAt,
      };

      this.store.upsertFileOwnership(ownership);
      this.bus.emit({ type: 'file_claimed', ownership });

      return { granted: true, ownership, conflict: null };
    });
  }

  /**
   * Release a file claim.
   * Returns true if the file was previously claimed, false otherwise.
   */
  release(filePath: string, agentId: AgentId): boolean {
    const existing = this.store.getFileOwnership(filePath);
    if (existing?.agentId !== agentId) return false;

    this.store.deleteFileOwnership(filePath);
    this.bus.emit({ type: 'file_released', filePath, agentId });

    return true;
  }

  /**
   * Release all file claims held by an agent.
   * Returns the number of claims released.
   */
  releaseAll(agentId: AgentId): number {
    const files = this.store.getFilesByAgent(agentId);
    if (files.length === 0) return 0;

    for (const file of files) {
      this.bus.emit({ type: 'file_released', filePath: file.filePath, agentId });
    }
    this.store.deleteFilesByAgent(agentId);

    return files.length;
  }

  /**
   * Check if a file is available for a given agent and mode.
   * Does not create a claim — just queries the current state.
   */
  isAvailable(filePath: string, agentId: AgentId, mode: OwnershipMode): boolean {
    const existing = this.store.getFileOwnership(filePath);
    if (!existing) return true;
    if (existing.agentId === agentId) return true;

    // Shared + shared = compatible
    if (existing.mode === 'shared' && mode === 'shared') return true;

    return false;
  }

  /** Get the current ownership of a file, if any. */
  getOwnership(filePath: string): FileOwnership | undefined {
    return this.store.getFileOwnership(filePath);
  }

  /** Get all files claimed by a specific agent. */
  getFilesByAgent(agentId: AgentId): readonly FileOwnership[] {
    return this.store.getFilesByAgent(agentId);
  }

  /** Get all current file ownerships. */
  getAllOwnerships(): readonly FileOwnership[] {
    return this.store.getAllFileOwnerships();
  }

  /**
   * Clean up expired file claims.
   * Returns the number of expired claims removed.
   */
  cleanupExpired(): number {
    const now = isoTimestamp();
    const expired = this.store.getExpiredFiles(now);

    for (const file of expired) {
      this.store.deleteFileOwnership(file.filePath);
      this.bus.emit({
        type: 'file_released',
        filePath: file.filePath,
        agentId: file.agentId,
      });
    }

    return expired.length;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Detect a conflict between an existing claim and a new request.
   *
   * Rules:
   * - Shared + Shared = no conflict (cooperative)
   * - Any other combination = conflict
   */
  private detectConflict(existing: FileOwnership, request: ClaimInput): Conflict | null {
    // Both shared → no conflict
    if (existing.mode === 'shared' && request.mode === 'shared') {
      return null;
    }

    // Determine severity based on modes
    const severity =
      existing.mode === 'exclusive' && request.mode === 'exclusive' ? 'high' : 'medium';

    const description =
      existing.mode === 'exclusive' && request.mode === 'exclusive'
        ? `Both agents want exclusive access to "${request.filePath}"`
        : `Conflicting ownership modes on "${request.filePath}" (${existing.mode} vs ${request.mode})`;

    return {
      id: conflictId(randomUUID()),
      type: 'file_contention',
      severity,
      agentA: existing.agentId,
      agentB: request.agentId,
      filePaths: [request.filePath],
      description,
      resolved: false,
      detectedAt: isoTimestamp(),
    };
  }
}
