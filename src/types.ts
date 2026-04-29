/**
 * Core domain types for Claude Hive Mind.
 *
 * This file defines the shared vocabulary for the entire system.
 * Every service, tool, and transport layer speaks these types.
 *
 * Design decisions:
 * - String literal unions over TS enums (tree-shakeable, no runtime cost)
 * - Readonly interfaces (immutability by default)
 * - Branded types for IDs (prevent accidental swaps)
 * - ISO 8601 strings for timestamps (serialization-friendly)
 */

// ---------------------------------------------------------------------------
// Branded ID types — prevent accidentally passing an AgentId where a TaskId
// is expected. The __brand field exists only at compile time.
// ---------------------------------------------------------------------------

/** Unique identifier for a connected AI instance. */
export type AgentId = string & { readonly __brand: 'AgentId' };

/** Unique identifier for a task in the shared queue. */
export type TaskId = string & { readonly __brand: 'TaskId' };

/** Unique identifier for a detected conflict. */
export type ConflictId = string & { readonly __brand: 'ConflictId' };

/** Unique identifier for an architectural decision. */
export type DecisionId = string & { readonly __brand: 'DecisionId' };

/** ISO 8601 timestamp string. */
export type ISOTimestamp = string & { readonly __brand: 'ISOTimestamp' };

// ---------------------------------------------------------------------------
// Agent Registry
// ---------------------------------------------------------------------------

/** Possible states of a connected agent. */
export type AgentStatus = 'active' | 'idle' | 'busy' | 'disconnected';

/** What kind of AI tool is this agent? */
export type AgentTool = 'claude-code' | 'cursor' | 'copilot' | 'codex' | 'windsurf' | 'other';

/** A connected AI coding assistant instance. */
export interface AgentRecord {
  readonly id: AgentId;
  /** Human-readable name, e.g. "Gabriel's Claude Code" */
  readonly displayName: string;
  /** Which AI tool is running this agent */
  readonly tool: AgentTool;
  /** Current lifecycle state */
  readonly status: AgentStatus;
  /** ID of the task this agent is currently working on, if any */
  readonly currentTaskId: TaskId | null;
  /** Last successful heartbeat from this agent */
  readonly lastHeartbeat: ISOTimestamp;
  /** When this agent first connected */
  readonly connectedAt: ISOTimestamp;
  /** Workspace root path on the agent's machine */
  readonly workspacePath: string;
  /** Current git branch this agent is working on (null = unknown) */
  readonly currentBranch: string | null;
  /** Repository URL for this agent's workspace (null = unknown) */
  readonly repoUrl: string | null;
}

// ---------------------------------------------------------------------------
// File Ownership
// ---------------------------------------------------------------------------

/** How an agent holds a file claim. */
export type OwnershipMode = 'exclusive' | 'shared';

/**
 * A file claim by an agent.
 *
 * Exclusive: only this agent can edit the file.
 * Shared: multiple agents can read, but edits require coordination.
 */
export interface FileOwnership {
  /** Absolute or repo-relative file path */
  readonly filePath: string;
  /** Agent that holds this claim */
  readonly agentId: AgentId;
  /** Exclusive lock or shared access */
  readonly mode: OwnershipMode;
  /** Task this claim is associated with, if any */
  readonly taskId: TaskId | null;
  /** When the claim was created */
  readonly claimedAt: ISOTimestamp;
  /** When the claim auto-expires (null = manual release only) */
  readonly expiresAt: ISOTimestamp | null;
  /** Git branch this claim belongs to (null = unknown) */
  readonly branch: string | null;
}

// ---------------------------------------------------------------------------
// Task Queue
// ---------------------------------------------------------------------------

/** Lifecycle states of a task. */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

/** Priority levels for task ordering. */
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

/**
 * A unit of work in the shared task queue.
 *
 * Tasks can depend on other tasks (DAG). An agent claims a task
 * before starting work, and the hive mind tracks progress.
 */
export interface Task {
  readonly id: TaskId;
  /** Short description of what needs to be done */
  readonly title: string;
  /** Detailed description with context and acceptance criteria */
  readonly description: string;
  /** Agent currently assigned to this task (null = unassigned) */
  readonly assignedAgentId: AgentId | null;
  /** Current lifecycle state */
  readonly status: TaskStatus;
  /** How urgent is this task */
  readonly priority: TaskPriority;
  /** Files this task expects to touch */
  readonly filePaths: readonly string[];
  /** Task IDs that must complete before this one can start */
  readonly dependsOn: readonly TaskId[];
  /** When the task was created */
  readonly createdAt: ISOTimestamp;
  /** When the task last changed status */
  readonly updatedAt: ISOTimestamp;
}

// ---------------------------------------------------------------------------
// Knowledge Store (RAG-lite)
// ---------------------------------------------------------------------------

/**
 * A cached piece of knowledge shared across all agents.
 *
 * When one agent analyzes a file or discovers something useful,
 * it stores the result here. Other agents can query instead of
 * re-reading and re-analyzing the same files.
 */
export interface KnowledgeEntry {
  /** Lookup key, e.g. "file:src/auth.ts:summary" or "pattern:error-handling" */
  readonly key: string;
  /** The actual knowledge content */
  readonly value: string;
  /** Agent that produced this knowledge */
  readonly agentId: AgentId;
  /** Hash of the source file at time of analysis (for invalidation) */
  readonly sourceHash: string | null;
  /** When this entry was created */
  readonly createdAt: ISOTimestamp;
  /** Seconds until this entry expires (null = never) */
  readonly ttlSeconds: number | null;
}

// ---------------------------------------------------------------------------
// Decision Log
// ---------------------------------------------------------------------------

/** Categories for architectural decisions. */
export type DecisionCategory =
  | 'architecture'
  | 'api-design'
  | 'database'
  | 'dependency'
  | 'convention'
  | 'security'
  | 'performance'
  | 'other';

/**
 * An architectural decision recorded in the shared log.
 *
 * Append-only: decisions are never edited, only superseded
 * by newer decisions with the same category.
 */
export interface Decision {
  readonly id: DecisionId;
  /** Agent that made this decision */
  readonly agentId: AgentId;
  /** What area does this decision cover */
  readonly category: DecisionCategory;
  /** Short summary: "Use JWT for API authentication" */
  readonly summary: string;
  /** Why this decision was made */
  readonly rationale: string;
  /** When the decision was recorded */
  readonly timestamp: ISOTimestamp;
}

// ---------------------------------------------------------------------------
// Conflict Detection
// ---------------------------------------------------------------------------

/** What kind of conflict was detected. */
export type ConflictType =
  | 'file_contention'
  | 'task_overlap'
  | 'decision_contradiction'
  | 'dependency_break';

/** How severe is this conflict. */
export type ConflictSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * A detected conflict between two agents.
 *
 * The conflict detector creates these when it spots potential
 * interference. Agents receive warnings via WebSocket.
 */
export interface Conflict {
  readonly id: ConflictId;
  /** What kind of conflict */
  readonly type: ConflictType;
  /** How bad is it */
  readonly severity: ConflictSeverity;
  /** First agent involved */
  readonly agentA: AgentId;
  /** Second agent involved */
  readonly agentB: AgentId;
  /** Files at the center of the conflict */
  readonly filePaths: readonly string[];
  /** Human-readable explanation of the conflict */
  readonly description: string;
  /** Has this conflict been acknowledged/resolved */
  readonly resolved: boolean;
  /** When the conflict was detected */
  readonly detectedAt: ISOTimestamp;
}

// ---------------------------------------------------------------------------
// Messages — agent-to-agent coordination signals (NOT commands)
// ---------------------------------------------------------------------------

/**
 * A coordination message between two agents (or a broadcast to all).
 *
 * Messages are FYI / coordination signals — "I'm doing X", "ready for review",
 * "I'll handle the database part" — NOT orders. The receiving agent decides
 * whether to react. There is no auto-execution of message contents.
 */
export interface AgentMessage {
  readonly id: string;
  readonly fromAgentId: AgentId;
  /** Recipient agent ID, or null for broadcast (everyone in the hive). */
  readonly toAgentId: AgentId | null;
  readonly content: string;
  readonly createdAt: ISOTimestamp;
}

/** Standard well-known metadata keys for `agent_metadata`. */
export interface AgentGitStatus {
  readonly branch: string | null;
  readonly head: string | null;
  readonly dirtyFiles: number;
  readonly aheadOfRemote: number;
  readonly behindRemote: number;
}

export interface AgentRunStatus {
  /** "test", "build", "lint", "typecheck", or arbitrary command label. */
  readonly command: string;
  readonly success: boolean;
  /** Short human-readable summary ("142/142 passed", "build failed at types.ts"). */
  readonly summary: string;
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Hive Mind State
// ---------------------------------------------------------------------------

/**
 * Complete state snapshot of the hive mind.
 * Used for dashboard rendering and full state sync.
 */
export interface HiveMindState {
  readonly agents: readonly AgentRecord[];
  readonly files: readonly FileOwnership[];
  readonly tasks: readonly Task[];
  readonly knowledge: readonly KnowledgeEntry[];
  readonly decisions: readonly Decision[];
  readonly conflicts: readonly Conflict[];
}

/**
 * Compact status summary for token-efficient context injection.
 *
 * This is what gets injected into an agent's context via hooks.
 * Designed to be ~300-500 tokens so it doesn't eat the context window.
 */
export interface HiveMindStatus {
  /** Number of currently connected agents */
  readonly activeAgents: number;
  /** Agent names and what they're doing */
  readonly agentSummaries: readonly AgentSummary[];
  /** Files currently claimed by any agent */
  readonly claimedFiles: readonly ClaimedFileSummary[];
  /** Unresolved conflicts */
  readonly activeConflicts: readonly ConflictSummary[];
  /** Pending + in-progress task count */
  readonly pendingTaskCount: number;
  /** When this status was generated */
  readonly generatedAt: ISOTimestamp;
}

/** Minimal agent info for the compact status. */
export interface AgentSummary {
  readonly id: AgentId;
  readonly displayName: string;
  readonly status: AgentStatus;
  readonly currentTask: string | null;
}

/** Minimal file ownership info for the compact status. */
export interface ClaimedFileSummary {
  readonly filePath: string;
  readonly agentName: string;
  readonly mode: OwnershipMode;
}

/** Minimal conflict info for the compact status. */
export interface ConflictSummary {
  readonly type: ConflictType;
  readonly severity: ConflictSeverity;
  readonly description: string;
}

// ---------------------------------------------------------------------------
// WebSocket Protocol
// ---------------------------------------------------------------------------

/**
 * Messages sent FROM the server TO connected clients.
 * Discriminated union on the `type` field.
 */
export type ServerMessage =
  | { readonly type: 'state_sync'; readonly state: HiveMindState }
  | { readonly type: 'agent_joined'; readonly agent: AgentRecord }
  | { readonly type: 'agent_left'; readonly agentId: AgentId }
  | {
      readonly type: 'agent_heartbeat';
      readonly agentId: AgentId;
      readonly timestamp: ISOTimestamp;
    }
  | { readonly type: 'file_claimed'; readonly ownership: FileOwnership }
  | {
      readonly type: 'file_released';
      readonly filePath: string;
      readonly agentId: AgentId;
      /**
       * How the claim ended:
       *   'manual'        — explicit release by the owning agent
       *   'expired'       — TTL elapsed; sweeper reaped it
       *   'disconnected'  — agent disconnected (manual or stale-cleanup); their claims auto-released
       */
      readonly reason: 'manual' | 'expired' | 'disconnected';
    }
  | { readonly type: 'task_created'; readonly task: Task }
  | { readonly type: 'task_updated'; readonly task: Task }
  | { readonly type: 'knowledge_shared'; readonly entry: KnowledgeEntry }
  | { readonly type: 'decision_logged'; readonly decision: Decision }
  | { readonly type: 'conflict_detected'; readonly conflict: Conflict }
  | { readonly type: 'conflict_resolved'; readonly conflictId: ConflictId }
  | { readonly type: 'status_update'; readonly status: HiveMindStatus }
  | { readonly type: 'message_received'; readonly message: AgentMessage }
  | {
      readonly type: 'agent_status_update';
      readonly agentId: AgentId;
      readonly key: string;
      readonly value: string;
      readonly updatedAt: ISOTimestamp;
    }
  | { readonly type: 'error'; readonly message: string };

/**
 * Messages sent FROM clients TO the server.
 * Discriminated union on the `type` field.
 */
export type ClientMessage =
  | {
      readonly type: 'register';
      readonly displayName: string;
      readonly tool: AgentTool;
      readonly workspacePath: string;
    }
  | { readonly type: 'heartbeat' }
  | {
      readonly type: 'claim_files';
      readonly filePaths: readonly string[];
      readonly mode: OwnershipMode;
      readonly taskId: TaskId | null;
    }
  | { readonly type: 'release_files'; readonly filePaths: readonly string[] }
  | { readonly type: 'subscribe_status' }
  | { readonly type: 'unsubscribe_status' };

// ---------------------------------------------------------------------------
// Utility types
// ---------------------------------------------------------------------------

/** Extract the `type` discriminator values from a message union. */
export type ServerMessageType = ServerMessage['type'];
export type ClientMessageType = ClientMessage['type'];

/** Look up a specific message variant by its type discriminator. */
export type ServerMessageOf<T extends ServerMessageType> = Extract<
  ServerMessage,
  { readonly type: T }
>;
export type ClientMessageOf<T extends ClientMessageType> = Extract<
  ClientMessage,
  { readonly type: T }
>;
