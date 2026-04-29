/**
 * Subset of types from the server (src/types.ts) needed by the dashboard.
 * Kept minimal so changes upstream don't break the UI bundle.
 */

export type AgentStatus = 'active' | 'idle' | 'busy' | 'disconnected';
export type AgentTool = 'claude-code' | 'cursor' | 'copilot' | 'codex' | 'windsurf' | 'other';

export interface Agent {
  id: string;
  displayName: string;
  tool: AgentTool;
  status: AgentStatus;
  currentBranch: string | null;
  currentTaskId?: string | null;
  lastHeartbeat?: string;
  connectedAt?: string;
  /** Present only for the caller's own record or for admin viewers. */
  workspacePath?: string;
  repoUrl?: string | null;
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedTo?: string | null;
  createdBy?: string | null;
  filePaths?: readonly string[];
  createdAt: string;
  updatedAt: string;
}

export type OwnershipMode = 'exclusive' | 'shared';

export interface FileClaim {
  filePath: string;
  agentId: string;
  mode: OwnershipMode;
  branch?: string | null;
  claimedAt: string;
  expiresAt?: string | null;
  reason?: string | null;
}

export type AgentMetadata = Record<string, { value: string; updatedAt: string }>;

export interface AgentMessage {
  id: string;
  fromAgentId: string;
  /** null = broadcast to everyone */
  toAgentId: string | null;
  content: string;
  createdAt: string;
}

/** Subset of WS messages the dashboard reacts to. */
export type ServerMessage =
  | { type: 'connected'; agentId: string | null }
  | { type: 'agent_joined'; agent: Agent }
  | { type: 'agent_left'; agentId: string }
  | { type: 'agent_heartbeat'; agentId: string; timestamp: string }
  | { type: string; [key: string]: unknown };
