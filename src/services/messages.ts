/**
 * Agent-to-agent coordination messages.
 *
 * Messages are FYI / coordination signals between agents (or broadcasts to
 * the whole hive). They are NOT commands — receiving agents decide whether
 * to act. There is no auto-execution of message content.
 *
 * Use cases:
 *   - "I'm working on auth.ts, can you take db.ts?"
 *   - "Tests pass on my branch, you can pull"
 *   - "Decided to use Zod, FYI" (broadcast)
 *   - "Stuck on this — anyone has insight?"
 *
 * Messages are persisted (so an agent that wasn't online sees them later)
 * but visibility is scoped: an agent sees broadcasts, DMs to them, and DMs
 * they sent. Admin sees everything.
 */

import { randomUUID } from 'node:crypto';
import { isoTimestamp } from '../schemas.js';
import type { AgentId, AgentMessage } from '../types.js';
import type { Store, MessageRow } from './store.js';
import type { EventBus } from './event-bus.js';

export interface SendMessageInput {
  readonly fromAgentId: AgentId;
  readonly toAgentId: AgentId | null;
  readonly content: string;
}

export class MessageService {
  private readonly store: Store;
  private readonly bus: EventBus;

  constructor(store: Store, bus: EventBus) {
    this.store = store;
    this.bus = bus;
  }

  /**
   * Send a message. `toAgentId === null` = broadcast to all.
   *
   * The message is persisted and emitted on the bus so any connected
   * client filters can pick it up.
   */
  send(input: SendMessageInput): AgentMessage {
    const id = randomUUID();
    const createdAt = isoTimestamp();
    const row: MessageRow = {
      id,
      from_agent_id: input.fromAgentId,
      to_agent_id: input.toAgentId,
      content: input.content,
      created_at: createdAt,
    };
    this.store.insertMessage(row);

    const message: AgentMessage = {
      id,
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      content: input.content,
      createdAt,
    };
    this.bus.emit({ type: 'message_received', message });
    return message;
  }

  /**
   * Get messages visible to an agent: broadcasts + DMs to them + DMs they sent.
   * Returns most recent first (descending by createdAt).
   */
  getForAgent(
    agentId: AgentId,
    options: { since?: string | null; limit?: number } = {},
  ): readonly AgentMessage[] {
    const limit = options.limit ?? 100;
    const since = options.since ?? null;
    return this.store.getMessagesForAgent(agentId, since, limit).map(rowToMessage);
  }

  /** Admin-only: see all messages. */
  getAll(options: { since?: string | null; limit?: number } = {}): readonly AgentMessage[] {
    const limit = options.limit ?? 100;
    const since = options.since ?? null;
    return this.store.getAllMessages(since, limit).map(rowToMessage);
  }

  get(id: string): AgentMessage | undefined {
    const row = this.store.getMessageById(id);
    return row ? rowToMessage(row) : undefined;
  }

  /** Caller is the sender (or admin). */
  delete(id: string): boolean {
    return this.store.deleteMessage(id);
  }
}

function rowToMessage(row: MessageRow): AgentMessage {
  return {
    id: row.id,
    fromAgentId: row.from_agent_id as AgentId,
    toAgentId: row.to_agent_id as AgentId | null,
    content: row.content,
    createdAt: row.created_at as AgentMessage['createdAt'],
  };
}
