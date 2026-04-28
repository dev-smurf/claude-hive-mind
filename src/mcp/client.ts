/**
 * HTTP client for the central Hive Mind server.
 *
 * Used by the MCP stdio server to forward tool calls to the
 * central coordination server. Handles registration, heartbeats,
 * and all domain operations.
 */

import type { AgentId } from '../types.js';
import { agentId } from '../schemas.js';

/** Default HTTP request timeout: 30 seconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ClientConfig {
  /** Base URL of the central server (e.g. "http://localhost:7777"). */
  readonly serverUrl: string;
  /** Auth token for the server (optional if auth is disabled). */
  readonly authToken?: string | undefined;
  /** Display name for this agent. */
  readonly displayName: string;
  /** Tool type (claude-code, cursor, codex, etc.). */
  readonly tool: string;
  /** Workspace path on this machine. */
  readonly workspacePath: string;
  /** Current git branch (optional). */
  readonly currentBranch?: string | undefined;
  /** Repository URL (optional). */
  readonly repoUrl?: string | undefined;
  /** Heartbeat interval in ms. */
  readonly heartbeatIntervalMs?: number | undefined;
  /** HTTP request timeout in ms (default: 30000). */
  readonly timeoutMs?: number | undefined;
}

export class HiveMindClient {
  private readonly config: ClientConfig;
  private agentIdValue: AgentId | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: ClientConfig) {
    this.config = config;
  }

  /** The agent ID assigned by the server after registration. */
  get agentId(): AgentId | null {
    return this.agentIdValue;
  }

  /**
   * Register with the central server and start heartbeats.
   */
  async connect(): Promise<AgentId> {
    const data = await this.post('/api/agents/register', {
      displayName: this.config.displayName,
      tool: this.config.tool,
      workspacePath: this.config.workspacePath,
      ...(this.config.currentBranch !== undefined ? { currentBranch: this.config.currentBranch } : {}),
      ...(this.config.repoUrl !== undefined ? { repoUrl: this.config.repoUrl } : {}),
    });

    const result = data as { id: string };
    this.agentIdValue = agentId(result.id);

    // Start heartbeat loop
    const interval = this.config.heartbeatIntervalMs ?? 10_000;
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat();
    }, interval);
    this.heartbeatTimer.unref();

    return this.agentIdValue;
  }

  /**
   * Disconnect from the central server and stop heartbeats.
   */
  async disconnect(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.agentIdValue) {
      await this.delete(`/api/agents/${this.agentIdValue}`);
      this.agentIdValue = null;
    }
  }

  // -------------------------------------------------------------------------
  // Tool implementations
  // -------------------------------------------------------------------------

  async getStatus(): Promise<unknown> {
    return this.get('/api/status');
  }

  async claimFile(filePath: string, mode: string, taskIdVal?: string, branch?: string): Promise<unknown> {
    return this.post('/api/files/claim', {
      filePath,
      agentId: this.requireAgentId(),
      mode,
      taskId: taskIdVal ?? null,
      ...(branch !== undefined ? { branch } : {}),
    });
  }

  async releaseFile(filePath: string): Promise<unknown> {
    return this.delete(
      `/api/files/${encodeURIComponent(filePath)}?agentId=${this.requireAgentId()}`,
    );
  }

  async checkFile(filePath: string): Promise<unknown> {
    return this.get(`/api/files/check/${encodeURIComponent(filePath)}`);
  }

  async createTask(input: {
    title: string;
    description: string;
    priority?: string;
    filePaths?: string[];
    dependsOn?: string[];
  }): Promise<unknown> {
    return this.post('/api/tasks', input);
  }

  async assignTask(taskIdVal: string): Promise<unknown> {
    return this.post(`/api/tasks/${taskIdVal}/assign`, {
      agentId: this.requireAgentId(),
    });
  }

  async completeTask(taskIdVal: string): Promise<unknown> {
    return this.post(`/api/tasks/${taskIdVal}/complete`, {});
  }

  async failTask(taskIdVal: string): Promise<unknown> {
    return this.post(`/api/tasks/${taskIdVal}/fail`, {});
  }

  async shareKnowledge(input: {
    key: string;
    value: string;
    sourceHash?: string;
    ttlSeconds?: number;
  }): Promise<unknown> {
    return this.post('/api/knowledge', {
      ...input,
      agentId: this.requireAgentId(),
    });
  }

  async getKnowledge(key: string): Promise<unknown> {
    return this.get(`/api/knowledge/${encodeURIComponent(key)}`);
  }

  async logDecision(input: {
    category: string;
    summary: string;
    rationale: string;
  }): Promise<unknown> {
    return this.post('/api/decisions', {
      ...input,
      agentId: this.requireAgentId(),
    });
  }

  async getConflicts(): Promise<unknown> {
    return this.get('/api/conflicts?unresolved=true');
  }

  async resolveConflict(conflictIdVal: string): Promise<unknown> {
    return this.post(`/api/conflicts/${conflictIdVal}/resolve`, {});
  }

  async updateBranch(branch: string): Promise<unknown> {
    return this.post(`/api/agents/${this.requireAgentId()}/branch`, { branch });
  }

  // -------------------------------------------------------------------------
  // Private HTTP helpers
  // -------------------------------------------------------------------------

  private requireAgentId(): string {
    if (!this.agentIdValue) {
      throw new Error('Not connected — call connect() first');
    }
    return this.agentIdValue;
  }

  private async heartbeat(): Promise<void> {
    try {
      if (this.agentIdValue) {
        await this.post(`/api/agents/${this.agentIdValue}/heartbeat`, {});
      }
    } catch {
      // Heartbeat failures are non-fatal — server will eventually mark us stale
    }
  }

  private get timeoutMs(): number {
    return this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.authToken) {
      h.Authorization = `Bearer ${this.config.authToken}`;
    }
    return h;
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.config.serverUrl}${path}`, {
      method: 'GET',
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GET ${path} failed (${String(res.status)}): ${body}`);
    }
    return res.json();
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.config.serverUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`POST ${path} failed (${String(res.status)}): ${text}`);
    }
    return res.json();
  }

  private async delete(path: string): Promise<unknown> {
    const res = await fetch(`${this.config.serverUrl}${path}`, {
      method: 'DELETE',
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DELETE ${path} failed (${String(res.status)}): ${text}`);
    }
    return res.json();
  }
}
