/**
 * MCP tool definitions for Claude Hive Mind.
 *
 * Each tool maps to an HTTP API call against the central server.
 * Tools are registered with the MCP SDK and become available
 * in the AI assistant's toolbox.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Tool schemas (Zod → MCP inputSchema)
// ---------------------------------------------------------------------------

export const hiveStatusSchema = z.object({});

export const hiveClaimFileSchema = z.object({
  filePath: z.string().describe('Path to the file to claim (repo-relative or absolute)'),
  mode: z.enum(['exclusive', 'shared']).describe('Exclusive lock or shared access'),
  taskId: z.string().optional().describe('Associated task ID'),
});

export const hiveReleaseFileSchema = z.object({
  filePath: z.string().describe('Path to the file to release'),
});

export const hiveCheckFileSchema = z.object({
  filePath: z.string().describe('Path to check availability'),
});

export const hiveCreateTaskSchema = z.object({
  title: z.string().describe('Short task title'),
  description: z.string().describe('Detailed description with acceptance criteria'),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('Task priority'),
  filePaths: z.array(z.string()).optional().describe('Files this task will touch'),
  dependsOn: z.array(z.string()).optional().describe('Task IDs that must complete first'),
});

export const hiveAssignTaskSchema = z.object({
  taskId: z.string().describe('ID of the task to claim'),
});

export const hiveCompleteTaskSchema = z.object({
  taskId: z.string().describe('ID of the task to mark complete'),
});

export const hiveFailTaskSchema = z.object({
  taskId: z.string().describe('ID of the task to mark failed'),
});

export const hiveShareKnowledgeSchema = z.object({
  key: z.string().describe('Lookup key (e.g. "file:src/auth.ts:summary")'),
  value: z.string().describe('The knowledge content'),
  sourceHash: z.string().optional().describe('Hash of the source file for invalidation'),
  ttlSeconds: z.number().optional().describe('Time-to-live in seconds (null = permanent)'),
});

export const hiveGetKnowledgeSchema = z.object({
  key: z.string().describe('Lookup key to retrieve'),
});

export const hiveLogDecisionSchema = z.object({
  category: z
    .enum([
      'architecture',
      'api-design',
      'database',
      'dependency',
      'convention',
      'security',
      'performance',
      'other',
    ])
    .describe('Decision category'),
  summary: z.string().describe('Short decision summary'),
  rationale: z.string().describe('Why this decision was made'),
});

export const hiveGetConflictsSchema = z.object({});

export const hiveResolveConflictSchema = z.object({
  conflictId: z.string().describe('ID of the conflict to resolve'),
});

// ---------------------------------------------------------------------------
// Tool metadata (for MCP registration)
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'hive_status',
    description:
      'Get the current status of the hive mind — connected agents, claimed files, ' +
      'pending tasks, and unresolved conflicts. Call this first to understand the ' +
      'current state before making changes.',
    inputSchema: hiveStatusSchema,
  },
  {
    name: 'hive_claim_file',
    description:
      'Claim a file before editing it. Use "exclusive" mode when you need sole access ' +
      '(prevents other agents from editing). Use "shared" mode for read-heavy files ' +
      'where multiple agents can coordinate. Returns a conflict if another agent has ' +
      'an incompatible claim.',
    inputSchema: hiveClaimFileSchema,
  },
  {
    name: 'hive_release_file',
    description:
      'Release your claim on a file when done editing. Always release files after ' +
      'completing your changes to unblock other agents.',
    inputSchema: hiveReleaseFileSchema,
  },
  {
    name: 'hive_check_file',
    description:
      'Check if a file is available before claiming it. Returns current ownership ' +
      'info without creating a claim. Useful to plan work and avoid conflicts.',
    inputSchema: hiveCheckFileSchema,
  },
  {
    name: 'hive_create_task',
    description:
      'Create a new task in the shared queue for any agent to pick up. Include ' +
      'clear acceptance criteria in the description. Use filePaths to declare ' +
      'which files the task will touch.',
    inputSchema: hiveCreateTaskSchema,
  },
  {
    name: 'hive_assign_task',
    description:
      'Claim a task from the queue to work on. The task must be pending and all ' +
      'dependencies must be completed. This marks the task as in_progress.',
    inputSchema: hiveAssignTaskSchema,
  },
  {
    name: 'hive_complete_task',
    description: 'Mark a task as completed after finishing the work.',
    inputSchema: hiveCompleteTaskSchema,
  },
  {
    name: 'hive_fail_task',
    description: 'Mark a task as failed if you cannot complete it.',
    inputSchema: hiveFailTaskSchema,
  },
  {
    name: 'hive_share_knowledge',
    description:
      'Share a piece of knowledge with all other agents. Use this after analyzing ' +
      'a file, discovering a pattern, or making a finding that other agents should ' +
      "know about. Use structured keys like 'file:path:aspect' or 'pattern:name'.",
    inputSchema: hiveShareKnowledgeSchema,
  },
  {
    name: 'hive_get_knowledge',
    description:
      'Retrieve a piece of shared knowledge by key. Check here before re-analyzing ' +
      'something another agent may have already figured out.',
    inputSchema: hiveGetKnowledgeSchema,
  },
  {
    name: 'hive_log_decision',
    description:
      'Record an architectural decision so all agents stay aligned. If your decision ' +
      'contradicts another agent, a conflict will be raised (but the decision is ' +
      'still recorded). Always log important decisions about architecture, database, ' +
      'security, dependencies, and conventions.',
    inputSchema: hiveLogDecisionSchema,
  },
  {
    name: 'hive_get_conflicts',
    description:
      'List all unresolved conflicts. Check this periodically and after operations ' +
      'that might conflict with other agents.',
    inputSchema: hiveGetConflictsSchema,
  },
  {
    name: 'hive_resolve_conflict',
    description:
      'Mark a conflict as resolved after coordinating with the other agent or ' +
      'making a decision about how to proceed.',
    inputSchema: hiveResolveConflictSchema,
  },
] as const;
