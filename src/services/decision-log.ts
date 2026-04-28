/**
 * Shared decision log for architectural alignment.
 *
 * When an agent makes an architectural decision (e.g. "use JWT for auth",
 * "use PostgreSQL for persistence"), it records it here. Other agents
 * can check the log before making their own decisions, preventing
 * contradictions across the codebase.
 *
 * The log is append-only — decisions are never edited. A new decision
 * in the same category supersedes (but does not delete) older ones.
 * This provides a full audit trail of how the project evolved.
 *
 * Contradiction detection: when a new decision conflicts with an
 * existing one in the same category by a different agent, a
 * 'decision_contradiction' conflict is raised.
 *
 * Inspired by:
 * - Architecture Decision Records (ADR) format
 * - disler/observability: decision broadcast to all sessions
 */

import { randomUUID } from 'node:crypto';
import type { AgentId, Conflict, Decision, DecisionCategory } from '../types.js';
import { conflictId, decisionId, isoTimestamp } from '../schemas.js';
import type { Store } from './store.js';
import type { EventBus } from './event-bus.js';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface LogDecisionInput {
  /** Agent recording the decision. */
  readonly agentId: AgentId;
  /** What area this decision covers. */
  readonly category: DecisionCategory;
  /** Short summary, e.g. "Use JWT for API authentication". */
  readonly summary: string;
  /** Why this decision was made — context and reasoning. */
  readonly rationale: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DecisionLog {
  private readonly store: Store;
  private readonly bus: EventBus;

  constructor(store: Store, bus: EventBus) {
    this.store = store;
    this.bus = bus;
  }

  /**
   * Record a new architectural decision.
   *
   * If a different agent has already logged a decision in the same
   * category, a 'decision_contradiction' conflict is raised (but the
   * new decision is still recorded — conflicts are informational).
   */
  log(input: LogDecisionInput): Decision {
    const decision: Decision = {
      id: decisionId(randomUUID()),
      agentId: input.agentId,
      category: input.category,
      summary: input.summary,
      rationale: input.rationale,
      timestamp: isoTimestamp(),
    };

    // Check for potential contradiction
    const existing = this.store.getDecisionsByCategory(input.category);
    const latestByOther = this.findLatestByOtherAgent(existing, input.agentId);

    if (latestByOther) {
      const conflict = this.buildContradiction(latestByOther, decision);
      this.store.insertConflict(conflict);
      this.bus.emit({ type: 'conflict_detected', conflict });
    }

    this.store.insertDecision(decision);
    this.bus.emit({ type: 'decision_logged', decision });

    return decision;
  }

  /** Get a single decision by ID. */
  get(id: Decision['id']): Decision | undefined {
    return this.store.getDecision(id);
  }

  /** Get all decisions, ordered by timestamp. */
  getAll(): readonly Decision[] {
    return this.store.getAllDecisions();
  }

  /** Get all decisions in a specific category, ordered by timestamp. */
  getByCategory(category: DecisionCategory): readonly Decision[] {
    return this.store.getDecisionsByCategory(category);
  }

  /**
   * Get the latest decision in a category (the current "active" one).
   * Returns undefined if no decisions exist in that category.
   */
  getLatest(category: DecisionCategory): Decision | undefined {
    const decisions = this.store.getDecisionsByCategory(category);
    return decisions.length > 0 ? decisions[decisions.length - 1] : undefined;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /** Find the most recent decision by a different agent in a category. */
  private findLatestByOtherAgent(
    decisions: readonly Decision[],
    currentAgentId: AgentId,
  ): Decision | undefined {
    for (let i = decisions.length - 1; i >= 0; i--) {
      if (decisions[i]?.agentId !== currentAgentId) {
        return decisions[i];
      }
    }
    return undefined;
  }

  /** Build a contradiction conflict between two decisions. */
  private buildContradiction(existing: Decision, incoming: Decision): Conflict {
    return {
      id: conflictId(randomUUID()),
      type: 'decision_contradiction',
      severity: 'medium',
      agentA: existing.agentId,
      agentB: incoming.agentId,
      filePaths: [],
      description: `Decision contradiction in "${incoming.category}": "${existing.summary}" (${existing.agentId}) vs "${incoming.summary}" (${incoming.agentId})`,
      resolved: false,
      detectedAt: isoTimestamp(),
    };
  }
}
