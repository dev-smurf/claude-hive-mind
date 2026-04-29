/**
 * Typed event bus for in-process pub/sub.
 *
 * Decouples services from transport — services emit events,
 * the HTTP/WebSocket layer subscribes and broadcasts.
 *
 * Inspired by:
 * - disler/observability: hook event collection + broadcast pattern
 * - Continuous-Claude-v3: PreToolUse broadcast to all registered sessions
 *
 * Design:
 * - Strongly typed: event names are ServerMessage['type'] literals
 * - Wildcard listener ('*') receives all events (for logging/debugging)
 * - Listeners are Sets (no duplicate subscriptions)
 * - Errors in listeners are caught and logged, never crash the emitter
 */

import type { ServerMessage, ServerMessageType } from '../types.js';
import { logger } from '../util/logger.js';

export type EventListener = (message: ServerMessage) => void;

export class EventBus {
  private readonly listeners = new Map<ServerMessageType | '*', Set<EventListener>>();

  /**
   * Subscribe to a specific event type.
   * Returns an unsubscribe function.
   */
  on(type: ServerMessageType | '*', listener: EventListener): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);

    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(type);
      }
    };
  }

  /**
   * Subscribe to a specific event type for one emission only.
   * Returns an unsubscribe function (in case you want to cancel early).
   */
  once(type: ServerMessageType | '*', listener: EventListener): () => void {
    const unsubscribe = this.on(type, (message) => {
      unsubscribe();
      listener(message);
    });
    return unsubscribe;
  }

  /**
   * Emit an event to all matching listeners.
   * Listeners for the specific type AND wildcard ('*') are notified.
   * Errors in listeners are caught and logged, never propagated.
   */
  emit(message: ServerMessage): void {
    const specific = this.listeners.get(message.type);
    const wildcard = this.listeners.get('*');

    if (specific) {
      for (const listener of specific) {
        try {
          listener(message);
        } catch (error: unknown) {
          logger.error('event-bus', 'Listener error', {
            type: message.type,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (wildcard) {
      for (const listener of wildcard) {
        try {
          listener(message);
        } catch (error: unknown) {
          logger.error('event-bus', 'Wildcard listener error', {
            type: message.type,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  /** Number of listeners for a specific event type (or '*'). */
  listenerCount(type: ServerMessageType | '*'): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  /** Remove all listeners for all event types. */
  clear(): void {
    this.listeners.clear();
  }
}
