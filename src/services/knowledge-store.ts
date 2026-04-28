/**
 * Shared knowledge cache across all connected agents.
 *
 * When one agent analyzes a file, discovers a pattern, or produces
 * any reusable insight, it stores the result here. Other agents can
 * query the store instead of re-doing the same analysis — saving
 * both time and API calls.
 *
 * Key format convention:
 *   file:<path>:<aspect>  — e.g. "file:src/auth.ts:summary"
 *   pattern:<name>        — e.g. "pattern:error-handling"
 *   config:<key>          — e.g. "config:database-schema"
 *   decision:<topic>      — e.g. "decision:auth-strategy"
 *
 * Entries can have a TTL (auto-expire after N seconds) or live
 * indefinitely. A sourceHash field enables invalidation when the
 * underlying source file changes.
 *
 * The store enforces a max entry count — when full, oldest entries
 * are evicted (LRU-like behavior on creation time).
 *
 * Inspired by:
 * - disler/observability: knowledge_shared event for broadcasting insights
 * - Continuous-Claude-v3: session-level knowledge cache with TTL
 */

import type { AgentId, KnowledgeEntry } from '../types.js';
import { isoTimestamp } from '../schemas.js';
import type { Config } from '../config.js';
import type { Store } from './store.js';
import type { EventBus } from './event-bus.js';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface ShareInput {
  /** Lookup key (e.g. "file:src/auth.ts:summary"). */
  readonly key: string;
  /** The knowledge content. */
  readonly value: string;
  /** Agent sharing this knowledge. */
  readonly agentId: AgentId;
  /** Hash of the source file for invalidation (optional). */
  readonly sourceHash?: string | null;
  /** TTL in seconds (overrides config default). null = no expiry. */
  readonly ttlSeconds?: number | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class KnowledgeStore {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly config: Config;

  constructor(store: Store, bus: EventBus, config: Config) {
    this.store = store;
    this.bus = bus;
    this.config = config;
  }

  /**
   * Share a piece of knowledge with all agents.
   *
   * If an entry with the same key already exists, it's updated.
   * When the store is full (maxKnowledgeEntries), the oldest
   * entries are evicted to make room.
   */
  share(input: ShareInput): KnowledgeEntry {
    const ttlSeconds =
      input.ttlSeconds === undefined ? this.config.defaultKnowledgeTtlSeconds : input.ttlSeconds;

    const entry: KnowledgeEntry = {
      key: input.key,
      value: input.value,
      agentId: input.agentId,
      sourceHash: input.sourceHash ?? null,
      createdAt: isoTimestamp(),
      ttlSeconds,
    };

    // Evict oldest if at capacity (only for genuinely new keys)
    const existing = this.store.getKnowledge(input.key);
    if (!existing) {
      const count = this.store.countKnowledge();
      if (count >= this.config.maxKnowledgeEntries) {
        this.store.deleteOldestKnowledge(this.config.maxKnowledgeEntries - 1);
      }
    }

    this.store.upsertKnowledge(entry);
    this.bus.emit({ type: 'knowledge_shared', entry });

    return entry;
  }

  /**
   * Look up a knowledge entry by key.
   * Returns undefined if not found.
   */
  get(key: string): KnowledgeEntry | undefined {
    return this.store.getKnowledge(key);
  }

  /**
   * Check if a knowledge entry is still valid based on source hash.
   *
   * Returns true if:
   * - The entry exists AND
   * - Either the entry has no sourceHash, OR
   * - The entry's sourceHash matches the provided hash
   */
  isValid(key: string, currentSourceHash: string | null): boolean {
    const entry = this.store.getKnowledge(key);
    if (!entry) return false;
    if (entry.sourceHash === null) return true;
    return entry.sourceHash === currentSourceHash;
  }

  /** Get all knowledge entries. */
  getAll(): readonly KnowledgeEntry[] {
    return this.store.getAllKnowledge();
  }

  /**
   * Delete a specific knowledge entry.
   * Returns true if the entry existed.
   */
  delete(key: string): boolean {
    const existing = this.store.getKnowledge(key);
    if (!existing) return false;

    this.store.deleteKnowledge(key);
    return true;
  }

  /**
   * Clean up expired knowledge entries.
   * Returns the number of entries removed.
   */
  cleanupExpired(): number {
    const now = isoTimestamp();
    return this.store.deleteExpiredKnowledge(now);
  }

  /** Get the current number of knowledge entries. */
  count(): number {
    return this.store.countKnowledge();
  }
}
