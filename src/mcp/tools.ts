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
  branch: z
    .string()
    .optional()
    .describe('Git branch for this claim (enables branch-aware conflict detection)'),
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

export const hiveUpdateBranchSchema = z.object({
  branch: z.string().describe('Current git branch name'),
});

export const hiveSendMessageSchema = z.object({
  toAgentId: z
    .string()
    .nullable()
    .describe(
      'Recipient agent ID, or null to broadcast to everyone in the hive. ' +
        'Get IDs from hive_status. Messages are FYI/coordination, NOT commands — ' +
        'the receiver decides how to react.',
    ),
  content: z.string().describe('What you want to say'),
});

export const hiveGetMessagesSchema = z.object({
  since: z.string().optional().describe('ISO timestamp; only return messages newer than this'),
  limit: z.number().int().positive().max(500).optional().describe('Max messages to return'),
});

export const hiveShareGitStatusSchema = z.object({
  branch: z.string().nullable().describe('Current branch name (e.g. "feature/auth")'),
  head: z.string().nullable().describe('HEAD commit short SHA'),
  dirtyFiles: z.number().int().nonnegative().describe('Count of modified-but-uncommitted files'),
  aheadOfRemote: z.number().int().nonnegative().describe('Commits ahead of upstream'),
  behindRemote: z.number().int().nonnegative().describe('Commits behind upstream'),
});

export const hiveShareRunResultSchema = z.object({
  command: z
    .string()
    .describe('Label for what you ran ("test", "build", "lint", "typecheck", or arbitrary)'),
  success: z.boolean().describe('Did it pass?'),
  summary: z
    .string()
    .describe('Short human-readable summary ("142/142 passed", "build failed at types.ts:23")'),
  durationMs: z.number().int().nonnegative().describe('How long it took (ms)'),
});

// ---------------------------------------------------------------------------
// Always-on tools (visible even when not connected to any hive)
// ---------------------------------------------------------------------------

export const hiveListSavedSchema = z.object({});

export const hiveConnectSchema = z.object({
  name: z
    .string()
    .describe(
      'Name of the saved hive to connect this session to. Run hive_list_saved to see available hives.',
    ),
  displayName: z.string().optional().describe('Optional override for this session display name'),
});

export const hiveDisconnectSchema = z.object({});

export const hiveJoinSchema = z.object({
  invite: z
    .string()
    .describe(
      'The invite URL (chm://server#code) or bare code shared by the hive host. ' +
        'If a bare code, also pass `server` with the host URL (http://host:7777).',
    ),
  server: z
    .url()
    .optional()
    .describe('Required only if `invite` is a bare code, not a chm:// URL.'),
  name: z
    .string()
    .optional()
    .describe('Short name to save this hive under locally (defaults to the server hostname).'),
  displayName: z
    .string()
    .optional()
    .describe('How this agent should appear on the hive dashboard (defaults to device hostname).'),
});

/** Always-on schema for hive_status (whether connected or not). */
export const hiveStatusSchemaAlwaysOn = z.object({});

// ---------------------------------------------------------------------------
// Tool metadata (for MCP registration)
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
}

/**
 * Tools available BEFORE the session has joined a hive. These are always
 * exposed by the MCP server even when no hive is connected, so the model
 * can list/choose/connect to a hive on demand.
 */
export const ALWAYS_ON_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'hive_list_saved',
    description:
      'List the hives this machine has been invited to (saved in ~/.claude-hive-mind/credentials.json). ' +
      'Returns names you can pass to hive_connect.',
    inputSchema: hiveListSavedSchema,
  },
  {
    name: 'hive_connect',
    description:
      'Connect THIS Claude session to a saved hive. Other Claude sessions on the same ' +
      'machine that have not called hive_connect remain disconnected. After this call, ' +
      'the full set of hive_* tools (hive_claim_file, hive_share_knowledge, etc.) becomes available.',
    inputSchema: hiveConnectSchema,
  },
  {
    name: 'hive_join',
    description:
      'One-shot: redeem an invite, save credentials for this machine, AND connect this session. ' +
      'Use this when a teammate shares an invite URL like "chm://server:7777#CODE-XYZ" — pass ' +
      'the whole string as `invite`. After this, the agent appears on the dashboard immediately ' +
      'and the full hive_* toolset is available.',
    inputSchema: hiveJoinSchema,
  },
  {
    name: 'hive_disconnect',
    description:
      'Disconnect THIS session from the hive. The MCP server keeps running but ' +
      'the hive_* tools are no longer available until you call hive_connect again.',
    inputSchema: hiveDisconnectSchema,
  },
  {
    name: 'hive_session_status',
    description:
      'Show whether this session is currently connected to a hive, and if so, which one ' +
      'and as which agent. Always available, even when disconnected.',
    inputSchema: hiveStatusSchemaAlwaysOn,
  },
] as const;

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
  {
    name: 'hive_update_branch',
    description:
      'Announce a git branch change. Call this after switching branches so the ' +
      'hive mind can scope file claims correctly. Agents on different branches ' +
      'can work on the same files without conflict.',
    inputSchema: hiveUpdateBranchSchema,
  },
  {
    name: 'hive_send_message',
    description:
      'Send a coordination message to another agent (or broadcast to all). ' +
      'Messages are FYI / coordination signals — "I am working on X", "ready ' +
      'for review", "decided to use Y" — NOT commands. The recipient decides ' +
      "how to react. Use null toAgentId to broadcast to everyone. Don't use " +
      'this to delegate work; use the task queue for that.',
    inputSchema: hiveSendMessageSchema,
  },
  {
    name: 'hive_get_messages',
    description:
      'Read messages addressed to you (and broadcasts). Returns most recent ' +
      'first. Useful at the start of a session and periodically to see what ' +
      'teammates are saying.',
    inputSchema: hiveGetMessagesSchema,
  },
  {
    name: 'hive_share_git_status',
    description:
      'Publish your current git state (branch, HEAD, dirty file count, ' +
      'ahead/behind upstream) so teammates know whether your code is in sync. ' +
      'Call this after major operations (commit, push, pull, branch switch). ' +
      'Run `git rev-parse --abbrev-ref HEAD`, `git rev-parse --short HEAD`, ' +
      '`git status --porcelain | wc -l`, `git rev-list --count @{upstream}..HEAD` ' +
      'and `git rev-list --count HEAD..@{upstream}` to gather the values.',
    inputSchema: hiveShareGitStatusSchema,
  },
  {
    name: 'hive_share_run_result',
    description:
      'Publish the result of a test/build/lint/typecheck run. Other agents see ' +
      '"Felix\'s tests are green" without having to ask. Call after running ' +
      'commands like `npm test`, `cargo build`, `tsc`, `eslint`. Set success ' +
      'based on exit code; summary is a short human-readable line.',
    inputSchema: hiveShareRunResultSchema,
  },
] as const;
