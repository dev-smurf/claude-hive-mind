/**
 * Valid test fixtures for all domain types.
 *
 * These represent realistic data that the system would actually
 * produce. Used by both schema tests and future service tests.
 */

import type {
  AgentRecord,
  FileOwnership,
  Task,
  KnowledgeEntry,
  Decision,
  Conflict,
  HiveMindState,
  HiveMindStatus,
  ServerMessage,
  ClientMessage,
} from '../../src/types.js';
import { agentId, taskId, conflictId, decisionId, isoTimestamp } from '../../src/schemas.js';

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

export const NOW = isoTimestamp(new Date('2026-04-28T12:00:00.000Z'));
export const EARLIER = isoTimestamp(new Date('2026-04-28T11:00:00.000Z'));
export const LATER = isoTimestamp(new Date('2026-04-28T13:00:00.000Z'));

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export const AGENT_GABRIEL: AgentRecord = {
  id: agentId('agent-gabriel-01'),
  displayName: "Gabriel's Claude Code",
  tool: 'claude-code',
  status: 'active',
  currentTaskId: taskId('task-001'),
  lastHeartbeat: NOW,
  connectedAt: EARLIER,
  workspacePath: '/home/gabriel/project',
};

export const AGENT_ALICE: AgentRecord = {
  id: agentId('agent-alice-01'),
  displayName: "Alice's Cursor",
  tool: 'cursor',
  status: 'busy',
  currentTaskId: taskId('task-002'),
  lastHeartbeat: NOW,
  connectedAt: EARLIER,
  workspacePath: '/home/alice/project',
};

export const AGENT_IDLE: AgentRecord = {
  id: agentId('agent-bob-01'),
  displayName: "Bob's Copilot",
  tool: 'copilot',
  status: 'idle',
  currentTaskId: null,
  lastHeartbeat: EARLIER,
  connectedAt: EARLIER,
  workspacePath: '/home/bob/project',
};

// ---------------------------------------------------------------------------
// File Ownership
// ---------------------------------------------------------------------------

export const OWNERSHIP_EXCLUSIVE: FileOwnership = {
  filePath: 'src/auth/login.ts',
  agentId: agentId('agent-gabriel-01'),
  mode: 'exclusive',
  taskId: taskId('task-001'),
  claimedAt: NOW,
  expiresAt: LATER,
};

export const OWNERSHIP_SHARED: FileOwnership = {
  filePath: 'src/types.ts',
  agentId: agentId('agent-alice-01'),
  mode: 'shared',
  taskId: null,
  claimedAt: NOW,
  expiresAt: null,
};

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const TASK_PENDING: Task = {
  id: taskId('task-001'),
  title: 'Implement JWT authentication',
  description: 'Add JWT token generation and validation to the auth module',
  assignedAgentId: null,
  status: 'pending',
  priority: 'high',
  filePaths: ['src/auth/login.ts', 'src/auth/middleware.ts'],
  dependsOn: [],
  createdAt: EARLIER,
  updatedAt: EARLIER,
};

export const TASK_IN_PROGRESS: Task = {
  id: taskId('task-002'),
  title: 'Add rate limiting to API endpoints',
  description: 'Implement rate limiting middleware using sliding window algorithm',
  assignedAgentId: agentId('agent-alice-01'),
  status: 'in_progress',
  priority: 'medium',
  filePaths: ['src/middleware/rate-limit.ts'],
  dependsOn: [taskId('task-001')],
  createdAt: EARLIER,
  updatedAt: NOW,
};

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

export const KNOWLEDGE_FILE_SUMMARY: KnowledgeEntry = {
  key: 'file:src/auth/login.ts:summary',
  value:
    'Express route handler for /login. Accepts email+password, returns JWT. Uses bcrypt for password comparison.',
  agentId: agentId('agent-gabriel-01'),
  sourceHash: 'abc123def456',
  createdAt: NOW,
  ttlSeconds: 3600,
};

export const KNOWLEDGE_PATTERN: KnowledgeEntry = {
  key: 'pattern:error-handling',
  value: 'Project uses Result<T, E> pattern from neverthrow. No try/catch in business logic.',
  agentId: agentId('agent-alice-01'),
  sourceHash: null,
  createdAt: NOW,
  ttlSeconds: null,
};

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export const DECISION_AUTH: Decision = {
  id: decisionId('dec-001'),
  agentId: agentId('agent-gabriel-01'),
  category: 'security',
  summary: 'Use JWT with RS256 for API authentication',
  rationale:
    'RS256 allows token verification without shared secrets. Refresh tokens stored in httpOnly cookies.',
  timestamp: NOW,
};

export const DECISION_DB: Decision = {
  id: decisionId('dec-002'),
  agentId: agentId('agent-alice-01'),
  category: 'database',
  summary: 'Use PostgreSQL with Drizzle ORM',
  rationale: 'Type-safe queries, good migration story, team already familiar with it.',
  timestamp: EARLIER,
};

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

export const CONFLICT_FILE: Conflict = {
  id: conflictId('conflict-001'),
  type: 'file_contention',
  severity: 'high',
  agentA: agentId('agent-gabriel-01'),
  agentB: agentId('agent-alice-01'),
  filePaths: ['src/auth/login.ts'],
  description:
    "Both agents are modifying src/auth/login.ts. Gabriel has exclusive claim but Alice's task also targets this file.",
  resolved: false,
  detectedAt: NOW,
};

// ---------------------------------------------------------------------------
// Composite state
// ---------------------------------------------------------------------------

export const FULL_STATE: HiveMindState = {
  agents: [AGENT_GABRIEL, AGENT_ALICE, AGENT_IDLE],
  files: [OWNERSHIP_EXCLUSIVE, OWNERSHIP_SHARED],
  tasks: [TASK_PENDING, TASK_IN_PROGRESS],
  knowledge: [KNOWLEDGE_FILE_SUMMARY, KNOWLEDGE_PATTERN],
  decisions: [DECISION_AUTH, DECISION_DB],
  conflicts: [CONFLICT_FILE],
};

export const COMPACT_STATUS: HiveMindStatus = {
  activeAgents: 3,
  agentSummaries: [
    {
      id: agentId('agent-gabriel-01'),
      displayName: "Gabriel's Claude Code",
      status: 'active',
      currentTask: 'Implement JWT authentication',
    },
    {
      id: agentId('agent-alice-01'),
      displayName: "Alice's Cursor",
      status: 'busy',
      currentTask: 'Add rate limiting to API endpoints',
    },
    {
      id: agentId('agent-bob-01'),
      displayName: "Bob's Copilot",
      status: 'idle',
      currentTask: null,
    },
  ],
  claimedFiles: [
    { filePath: 'src/auth/login.ts', agentName: "Gabriel's Claude Code", mode: 'exclusive' },
    { filePath: 'src/types.ts', agentName: "Alice's Cursor", mode: 'shared' },
  ],
  activeConflicts: [
    {
      type: 'file_contention',
      severity: 'high',
      description: 'Both agents modifying src/auth/login.ts',
    },
  ],
  pendingTaskCount: 2,
  generatedAt: NOW,
};

// ---------------------------------------------------------------------------
// WebSocket messages
// ---------------------------------------------------------------------------

export const SERVER_MESSAGES: readonly ServerMessage[] = [
  { type: 'state_sync', state: FULL_STATE },
  { type: 'agent_joined', agent: AGENT_GABRIEL },
  { type: 'agent_left', agentId: agentId('agent-bob-01') },
  { type: 'agent_heartbeat', agentId: agentId('agent-gabriel-01'), timestamp: NOW },
  { type: 'file_claimed', ownership: OWNERSHIP_EXCLUSIVE },
  { type: 'file_released', filePath: 'src/types.ts', agentId: agentId('agent-alice-01') },
  { type: 'task_created', task: TASK_PENDING },
  { type: 'task_updated', task: TASK_IN_PROGRESS },
  { type: 'knowledge_shared', entry: KNOWLEDGE_FILE_SUMMARY },
  { type: 'decision_logged', decision: DECISION_AUTH },
  { type: 'conflict_detected', conflict: CONFLICT_FILE },
  { type: 'conflict_resolved', conflictId: conflictId('conflict-001') },
  { type: 'status_update', status: COMPACT_STATUS },
  { type: 'error', message: 'Agent not found' },
];

export const CLIENT_MESSAGES: readonly ClientMessage[] = [
  {
    type: 'register',
    displayName: "Gabriel's Claude Code",
    tool: 'claude-code',
    workspacePath: '/home/gabriel/project',
  },
  { type: 'heartbeat' },
  {
    type: 'claim_files',
    filePaths: ['src/auth/login.ts'],
    mode: 'exclusive',
    taskId: taskId('task-001'),
  },
  { type: 'release_files', filePaths: ['src/auth/login.ts'] },
  { type: 'subscribe_status' },
  { type: 'unsubscribe_status' },
];
