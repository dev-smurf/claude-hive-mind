/**
 * Zod schemas for runtime validation at system boundaries.
 *
 * These mirror the interfaces in types.ts but provide actual
 * runtime validation. Used for:
 * - MCP tool input validation
 * - WebSocket message parsing
 * - REST API request validation
 * - Database row hydration
 *
 * Convention: schema names match type names with a "Schema" suffix.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Length limits
// ---------------------------------------------------------------------------

/** Length caps applied at HTTP/MCP boundaries to prevent unbounded inputs. */
export const LENGTH_LIMITS = {
  /** Display names, tool names, branch names. */
  shortName: 200,
  /** File paths, workspace paths, repo URLs, knowledge keys. */
  path: 1024,
  /** Decision summaries. */
  summary: 500,
  /** Decision rationales, knowledge values, task descriptions. */
  longText: 100_000,
  /** Task titles. */
  title: 500,
  /** Conflict descriptions. */
  description: 2_000,
} as const;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Validates a non-empty trimmed string with a default cap. */
const nonEmptyString = z.string().trim().min(1).max(LENGTH_LIMITS.longText);

/** Short, single-line strings (names, branches, etc.). */
const shortString = z.string().trim().min(1).max(LENGTH_LIMITS.shortName);

/** Path-like strings. */
const pathString = z.string().trim().min(1).max(LENGTH_LIMITS.path);

/** Validates an ISO 8601 timestamp string. */
export const isoTimestampSchema = z.iso.datetime();

// ---------------------------------------------------------------------------
// Enums (string literal unions)
// ---------------------------------------------------------------------------

export const agentStatusSchema = z.enum(['active', 'idle', 'busy', 'disconnected']);

export const agentToolSchema = z.enum([
  'claude-code',
  'cursor',
  'copilot',
  'codex',
  'windsurf',
  'other',
]);

export const ownershipModeSchema = z.enum(['exclusive', 'shared']);

export const taskStatusSchema = z.enum([
  'pending',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
]);

export const taskPrioritySchema = z.enum(['low', 'medium', 'high', 'critical']);

export const decisionCategorySchema = z.enum([
  'architecture',
  'api-design',
  'database',
  'dependency',
  'convention',
  'security',
  'performance',
  'other',
]);

export const conflictTypeSchema = z.enum([
  'file_contention',
  'task_overlap',
  'decision_contradiction',
  'dependency_break',
]);

export const conflictSeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);

// ---------------------------------------------------------------------------
// Domain objects
// ---------------------------------------------------------------------------

export const agentRecordSchema = z.object({
  id: nonEmptyString,
  displayName: nonEmptyString,
  tool: agentToolSchema,
  status: agentStatusSchema,
  currentTaskId: nonEmptyString.nullable(),
  lastHeartbeat: isoTimestampSchema,
  connectedAt: isoTimestampSchema,
  workspacePath: nonEmptyString,
  currentBranch: nonEmptyString.nullable(),
  repoUrl: nonEmptyString.nullable(),
});

export const fileOwnershipSchema = z.object({
  filePath: nonEmptyString,
  agentId: nonEmptyString,
  mode: ownershipModeSchema,
  taskId: nonEmptyString.nullable(),
  claimedAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema.nullable(),
  branch: nonEmptyString.nullable(),
});

export const taskSchema = z.object({
  id: nonEmptyString,
  title: nonEmptyString,
  description: z.string(),
  assignedAgentId: nonEmptyString.nullable(),
  status: taskStatusSchema,
  priority: taskPrioritySchema,
  filePaths: z.array(nonEmptyString),
  dependsOn: z.array(nonEmptyString),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

export const knowledgeEntrySchema = z.object({
  key: nonEmptyString,
  value: nonEmptyString,
  agentId: nonEmptyString,
  sourceHash: nonEmptyString.nullable(),
  createdAt: isoTimestampSchema,
  ttlSeconds: z.number().int().positive().nullable(),
});

export const decisionSchema = z.object({
  id: nonEmptyString,
  agentId: nonEmptyString,
  category: decisionCategorySchema,
  summary: nonEmptyString,
  rationale: nonEmptyString,
  timestamp: isoTimestampSchema,
});

export const conflictSchema = z.object({
  id: nonEmptyString,
  type: conflictTypeSchema,
  severity: conflictSeveritySchema,
  agentA: nonEmptyString,
  agentB: nonEmptyString,
  filePaths: z.array(nonEmptyString),
  description: nonEmptyString,
  resolved: z.boolean(),
  detectedAt: isoTimestampSchema,
});

// ---------------------------------------------------------------------------
// Hive Mind State
// ---------------------------------------------------------------------------

export const hiveMindStateSchema = z.object({
  agents: z.array(agentRecordSchema),
  files: z.array(fileOwnershipSchema),
  tasks: z.array(taskSchema),
  knowledge: z.array(knowledgeEntrySchema),
  decisions: z.array(decisionSchema),
  conflicts: z.array(conflictSchema),
});

export const agentSummarySchema = z.object({
  id: nonEmptyString,
  displayName: nonEmptyString,
  status: agentStatusSchema,
  currentTask: nonEmptyString.nullable(),
});

export const claimedFileSummarySchema = z.object({
  filePath: nonEmptyString,
  agentName: nonEmptyString,
  mode: ownershipModeSchema,
});

export const conflictSummarySchema = z.object({
  type: conflictTypeSchema,
  severity: conflictSeveritySchema,
  description: nonEmptyString,
});

export const hiveMindStatusSchema = z.object({
  activeAgents: z.number().int().nonnegative(),
  agentSummaries: z.array(agentSummarySchema),
  claimedFiles: z.array(claimedFileSummarySchema),
  activeConflicts: z.array(conflictSummarySchema),
  pendingTaskCount: z.number().int().nonnegative(),
  generatedAt: isoTimestampSchema,
});

// ---------------------------------------------------------------------------
// WebSocket Messages
// ---------------------------------------------------------------------------

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state_sync'), state: hiveMindStateSchema }),
  z.object({ type: z.literal('agent_joined'), agent: agentRecordSchema }),
  z.object({ type: z.literal('agent_left'), agentId: nonEmptyString }),
  z.object({
    type: z.literal('agent_heartbeat'),
    agentId: nonEmptyString,
    timestamp: isoTimestampSchema,
  }),
  z.object({ type: z.literal('file_claimed'), ownership: fileOwnershipSchema }),
  z.object({
    type: z.literal('file_released'),
    filePath: nonEmptyString,
    agentId: nonEmptyString,
    reason: z.enum(['manual', 'expired', 'disconnected']),
  }),
  z.object({ type: z.literal('task_created'), task: taskSchema }),
  z.object({ type: z.literal('task_updated'), task: taskSchema }),
  z.object({ type: z.literal('knowledge_shared'), entry: knowledgeEntrySchema }),
  z.object({ type: z.literal('decision_logged'), decision: decisionSchema }),
  z.object({ type: z.literal('conflict_detected'), conflict: conflictSchema }),
  z.object({ type: z.literal('conflict_resolved'), conflictId: nonEmptyString }),
  z.object({ type: z.literal('status_update'), status: hiveMindStatusSchema }),
  z.object({ type: z.literal('error'), message: nonEmptyString }),
]);

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('register'),
    displayName: nonEmptyString,
    tool: agentToolSchema,
    workspacePath: nonEmptyString,
    currentBranch: nonEmptyString.nullable().optional(),
    repoUrl: nonEmptyString.nullable().optional(),
  }),
  z.object({ type: z.literal('heartbeat') }),
  z.object({
    type: z.literal('claim_files'),
    filePaths: z.array(nonEmptyString).min(1),
    mode: ownershipModeSchema,
    taskId: nonEmptyString.nullable(),
  }),
  z.object({ type: z.literal('release_files'), filePaths: z.array(nonEmptyString).min(1) }),
  z.object({ type: z.literal('subscribe_status') }),
  z.object({ type: z.literal('unsubscribe_status') }),
]);

// ---------------------------------------------------------------------------
// HTTP route body schemas — validated at handler entry
// ---------------------------------------------------------------------------

export const registerAgentBodySchema = z.object({
  displayName: shortString,
  tool: agentToolSchema,
  workspacePath: pathString,
  currentBranch: shortString.nullable().optional(),
  repoUrl: pathString.nullable().optional(),
});

export const updateBranchBodySchema = z.object({
  branch: shortString.nullable(),
});

export const claimFileBodySchema = z.object({
  filePath: pathString,
  agentId: shortString,
  mode: ownershipModeSchema,
  taskId: shortString.nullable().optional(),
  ttlMs: z.number().int().positive().nullable().optional(),
  branch: shortString.nullable().optional(),
});

export const createTaskBodySchema = z.object({
  title: z.string().trim().min(1).max(LENGTH_LIMITS.title),
  description: z.string().max(LENGTH_LIMITS.longText),
  priority: taskPrioritySchema.optional(),
  filePaths: z.array(pathString).max(1000).optional(),
  dependsOn: z.array(shortString).max(1000).optional(),
});

export const assignTaskBodySchema = z.object({
  agentId: shortString,
});

export const shareKnowledgeBodySchema = z.object({
  key: pathString,
  value: z.string().min(1).max(LENGTH_LIMITS.longText),
  agentId: shortString,
  sourceHash: shortString.nullable().optional(),
  ttlSeconds: z.number().int().positive().nullable().optional(),
});

export const logDecisionBodySchema = z.object({
  agentId: shortString,
  category: decisionCategorySchema,
  summary: z.string().trim().min(1).max(LENGTH_LIMITS.summary),
  rationale: z.string().trim().min(1).max(LENGTH_LIMITS.longText),
});

// ---------------------------------------------------------------------------
// ID factory helpers — create branded IDs from plain strings
// ---------------------------------------------------------------------------

import type { AgentId, TaskId, ConflictId, DecisionId, ISOTimestamp } from './types.js';

export function agentId(value: string): AgentId {
  return value as AgentId;
}

export function taskId(value: string): TaskId {
  return value as TaskId;
}

export function conflictId(value: string): ConflictId {
  return value as ConflictId;
}

export function decisionId(value: string): DecisionId {
  return value as DecisionId;
}

export function isoTimestamp(date: Date = new Date()): ISOTimestamp {
  return date.toISOString() as ISOTimestamp;
}
