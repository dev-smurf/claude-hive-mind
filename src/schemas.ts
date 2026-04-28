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
// Primitives
// ---------------------------------------------------------------------------

/** Validates a non-empty trimmed string. */
const nonEmptyString = z.string().trim().min(1);

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
  z.object({ type: z.literal('file_released'), filePath: nonEmptyString, agentId: nonEmptyString }),
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
