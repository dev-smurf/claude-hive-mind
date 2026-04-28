/**
 * Agent lifecycle management.
 *
 * Handles registration, heartbeats, disconnection, and stale agent
 * cleanup. Every connected AI instance (Claude Code, Cursor, Copilot,
 * etc.) is tracked here.
 *
 * Inspired by:
 * - kevensavard/Claude-Squad: SSS agent registry with heartbeat tracking
 * - Continuous-Claude-v3: session register with automatic cleanup
 *
 * Design:
 * - Agents get a crypto-random UUID on registration
 * - Heartbeats update the timestamp; missing heartbeats = stale
 * - Stale cleanup runs on a configurable interval
 * - Disconnecting an agent cascades: file claims released, task unassigned
 * - All mutations emit events through the EventBus
 */

import { randomUUID } from 'node:crypto';
import type { AgentId, AgentRecord, AgentTool, TaskId } from '../types.js';
import { agentId, isoTimestamp } from '../schemas.js';
import type { Config } from '../config.js';
import type { Store } from './store.js';
import type { EventBus } from './event-bus.js';
import type { TaskQueue } from './task-queue.js';

export interface RegisterInput {
  readonly displayName: string;
  readonly tool: AgentTool;
  readonly workspacePath: string;
  readonly currentBranch?: string | null;
  readonly repoUrl?: string | null;
}

export class AgentRegistry {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly config: Config;
  private taskQueue: TaskQueue | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(store: Store, bus: EventBus, config: Config) {
    this.store = store;
    this.bus = bus;
    this.config = config;
  }

  /**
   * Set the task queue reference for orphaned task cleanup on disconnect.
   * Called after construction to avoid circular dependency.
   */
  setTaskQueue(taskQueue: TaskQueue): void {
    this.taskQueue = taskQueue;
  }

  /**
   * Register a new agent and broadcast the event.
   * Returns the created AgentRecord with a fresh UUID.
   */
  register(input: RegisterInput): AgentRecord {
    const now = isoTimestamp();
    const agent: AgentRecord = {
      id: agentId(randomUUID()),
      displayName: input.displayName,
      tool: input.tool,
      status: 'active',
      currentTaskId: null,
      lastHeartbeat: now,
      connectedAt: now,
      workspacePath: input.workspacePath,
      currentBranch: input.currentBranch ?? null,
      repoUrl: input.repoUrl ?? null,
    };

    this.store.upsertAgent(agent);
    this.bus.emit({ type: 'agent_joined', agent });

    return agent;
  }

  /**
   * Update the current git branch of an agent.
   * Returns false if the agent doesn't exist.
   */
  updateBranch(id: AgentId, branch: string | null): boolean {
    const agent = this.store.getAgent(id);
    if (!agent) return false;

    this.store.updateAgentBranch(id, branch);
    return true;
  }

  /**
   * Process a heartbeat from an agent.
   * Updates the timestamp and sets status to 'active' if it was 'idle'.
   * Returns false if the agent doesn't exist.
   */
  heartbeat(id: AgentId): boolean {
    const agent = this.store.getAgent(id);
    if (!agent) return false;

    const now = isoTimestamp();
    this.store.updateAgentHeartbeat(id, now);

    // Revive idle agents on heartbeat
    if (agent.status === 'idle') {
      this.store.updateAgentStatus(id, 'active');
    }

    this.bus.emit({ type: 'agent_heartbeat', agentId: id, timestamp: now });
    return true;
  }

  /**
   * Mark an agent as busy with a specific task.
   * Returns false if the agent doesn't exist.
   */
  markBusy(id: AgentId, currentTaskId: TaskId): boolean {
    const agent = this.store.getAgent(id);
    if (!agent) return false;

    this.store.updateAgentStatus(id, 'busy');
    this.store.updateAgentTask(id, currentTaskId);
    return true;
  }

  /**
   * Mark an agent as idle (no current task).
   * Returns false if the agent doesn't exist.
   */
  markIdle(id: AgentId): boolean {
    const agent = this.store.getAgent(id);
    if (!agent) return false;

    this.store.updateAgentStatus(id, 'idle');
    this.store.updateAgentTask(id, null);
    return true;
  }

  /**
   * Disconnect an agent gracefully.
   *
   * Sets status to 'disconnected', releases all file claims,
   * unassigns any in_progress tasks (prevents orphans), and
   * broadcasts the departure. The agent record is kept for
   * history — stale cleanup will eventually remove it.
   */
  disconnect(id: AgentId): boolean {
    const agent = this.store.getAgent(id);
    if (!agent) return false;

    this.store.updateAgentStatus(id, 'disconnected');
    this.store.updateAgentTask(id, null);
    this.store.deleteFilesByAgent(id);

    // Unassign orphaned tasks so other agents can pick them up
    if (this.taskQueue) {
      this.taskQueue.unassignByAgent(id);
    }

    this.bus.emit({ type: 'agent_left', agentId: id });
    return true;
  }

  /**
   * Permanently remove an agent and all associated data.
   * Foreign key cascades handle file claims, knowledge, decisions.
   */
  remove(id: AgentId): boolean {
    const agent = this.store.getAgent(id);
    if (!agent) return false;

    this.store.deleteAgent(id);
    this.bus.emit({ type: 'agent_left', agentId: id });
    return true;
  }

  /** Get a single agent by ID. */
  getAgent(id: AgentId): AgentRecord | undefined {
    return this.store.getAgent(id);
  }

  /** Get all registered agents (any status). */
  getAllAgents(): readonly AgentRecord[] {
    return this.store.getAllAgents();
  }

  /** Get only agents with active/busy/idle status. */
  getConnectedAgents(): readonly AgentRecord[] {
    return this.store.getAllAgents().filter((a) => a.status !== 'disconnected');
  }

  /**
   * Find and disconnect agents whose heartbeat is older than the
   * configured timeout. Returns the IDs of agents that were cleaned up.
   *
   * This is the garbage collector for abandoned sessions — if an
   * agent crashes or loses network, it stops sending heartbeats
   * and eventually gets cleaned up here.
   */
  cleanupStale(): readonly AgentId[] {
    const cutoff = isoTimestamp(new Date(Date.now() - this.config.heartbeatTimeoutMs));
    const stale = this.store.getStaleAgents(cutoff);
    const cleaned: AgentId[] = [];

    for (const agent of stale) {
      this.disconnect(agent.id);
      cleaned.push(agent.id);
    }

    return cleaned;
  }

  /**
   * Start the periodic stale agent cleanup.
   * Runs at the interval configured in config.staleAgentCleanupMs.
   */
  startCleanupInterval(): void {
    if (this.cleanupTimer) return; // already running

    this.cleanupTimer = setInterval(() => {
      this.cleanupStale();
    }, this.config.staleAgentCleanupMs);

    // Don't block Node.js from exiting
    this.cleanupTimer.unref();
  }

  /** Stop the periodic stale agent cleanup. */
  stopCleanupInterval(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
