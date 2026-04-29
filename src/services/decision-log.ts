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
// Contradiction-detection tuning
// ---------------------------------------------------------------------------

/** Minimum Jaccard similarity between two summaries to flag as contradiction. */
const MIN_OVERLAP = 0.15;

/**
 * Categories where same-category cross-agent decisions are almost always
 * real contradictions (technical choices). Other categories — `convention`,
 * `other` — apply the keyword-overlap heuristic to avoid flagging unrelated
 * process decisions.
 */
const TECHNICAL_CHOICE_CATEGORIES = new Set<string>([
  'architecture',
  'api-design',
  'database',
  'dependency',
  'security',
  'performance',
]);

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'had',
  'has',
  'have',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'the',
  'this',
  'that',
  'to',
  'was',
  'will',
  'with',
  'when',
  'we',
  'you',
  'your',
  'they',
  'them',
  'their',
  'should',
  'would',
  'could',
  'just',
  'use',
  'using',
  'used',
  'all',
  'any',
  'every',
  'some',
  'into',
  'than',
  'then',
  'over',
  'under',
  'about',
  'because',
  'before',
  'after',
  'while',
  'where',
  'which',
  'these',
  'those',
  'must',
  'need',
  'each',
]);

function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const tok of text.split(/[^a-z0-9]+/)) {
    if (tok.length < 4) continue;
    if (STOPWORDS.has(tok)) continue;
    if (/^\d+$/.test(tok)) continue;
    out.add(tok);
  }
  return out;
}

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

    // Check for potential contradiction. We only flag pairs that:
    //  1. Are in the same category by a different agent
    //  2. Share enough topical overlap that they're plausibly about the same
    //     thing (Jaccard >= MIN_OVERLAP on content tokens)
    //  3. Are NOT explicit supersede markers (we treat those as agreements)
    const existing = this.store.getDecisionsByCategory(input.category);
    const latestByOther = this.findLatestByOtherAgent(existing, input.agentId);

    if (latestByOther && this.isLikelyContradiction(latestByOther, decision)) {
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

  /**
   * Heuristic: a pair is a likely contradiction iff
   *   1. Neither summary contains an explicit "supersede"-style marker
   *      (those are agreements, not contradictions), AND
   *   2. EITHER the category is a technical-choice one (architecture,
   *      database, dependency, etc.) where same-category cross-agent is
   *      almost always a real contradiction, OR
   *      the summaries share enough content tokens to be plausibly about
   *      the same subject (Jaccard >= MIN_OVERLAP).
   *
   * The split prevents the previous false-positive storm in `convention`
   * (process/etiquette) decisions while keeping real database/architecture
   * choice clashes flagged.
   */
  private isLikelyContradiction(existing: Decision, incoming: Decision): boolean {
    const a = `${existing.summary} ${existing.rationale}`.toLowerCase();
    const b = `${incoming.summary} ${incoming.rationale}`.toLowerCase();

    if (/\b(supersede|supersedes|obsoletes|replaces|defers? to)\b/.test(a)) return false;
    if (/\b(supersede|supersedes|obsoletes|replaces|defers? to)\b/.test(b)) return false;

    // Technical-choice categories: same-category cross-agent is always a
    // real contradiction worth flagging (e.g. PostgreSQL vs MongoDB share
    // zero keywords but are obviously conflicting database choices).
    if (TECHNICAL_CHOICE_CATEGORIES.has(incoming.category)) {
      return true;
    }

    // Process / convention categories: require topical overlap so unrelated
    // process decisions don't all flag against each other.
    const tokensA = contentTokens(a);
    const tokensB = contentTokens(b);
    if (tokensA.size === 0 || tokensB.size === 0) return false;

    let intersection = 0;
    for (const t of tokensA) {
      if (tokensB.has(t)) intersection++;
    }
    const union = tokensA.size + tokensB.size - intersection;
    if (union === 0) return false;
    return intersection / union >= MIN_OVERLAP;
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
