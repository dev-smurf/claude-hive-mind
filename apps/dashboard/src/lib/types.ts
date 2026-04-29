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
  /** Present only for the caller's own record or for admin viewers. */
  workspacePath?: string;
  repoUrl?: string | null;
}

/** Subset of WS messages the dashboard reacts to. */
export type ServerMessage =
  | { type: 'connected'; agentId: string | null }
  | { type: 'agent_joined'; agent: Agent }
  | { type: 'agent_left'; agentId: string }
  | { type: 'agent_heartbeat'; agentId: string; timestamp: string }
  | { type: string; [key: string]: unknown };
