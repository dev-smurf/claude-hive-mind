/**
 * WebSocket connection handler.
 *
 * Manages real-time event broadcasting to all connected clients.
 * When a service emits an event through the EventBus, the WS handler
 * forwards it to every connected WebSocket client.
 *
 * Auth: Clients authenticate via the Authorization header in the WS
 * upgrade request (not URL query params, which leak in logs).
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'node:http';
import type { EventBus } from '../services/event-bus.js';
import type { Config } from '../config.js';
import type { ServerMessage } from '../types.js';
import type { AgentRegistry } from '../services/agent-registry.js';
import { logger } from '../util/logger.js';
import { safeCompare } from './middleware.js';

/** High-water mark for WS send buffer (256KB). */
const WS_BUFFER_HIGH_WATER = 256 * 1024;

export interface WsClient {
  readonly ws: WebSocket;
  readonly agentId: string | null;
  readonly connectedAt: Date;
}

export class WsHandler {
  private readonly wss: WebSocketServer;
  private readonly bus: EventBus;
  private readonly config: Config;
  private readonly registry: AgentRegistry;
  private readonly clients = new Set<WsClient>();
  private unsubscribe: (() => void) | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(server: Server, bus: EventBus, config: Config, registry: AgentRegistry) {
    this.bus = bus;
    this.config = config;
    this.registry = registry;

    this.wss = new WebSocketServer({
      server,
      path: '/ws',
      maxPayload: config.wsMaxPayloadBytes,
    });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });
  }

  /** Start broadcasting events and ping interval. */
  start(): void {
    // Subscribe to all EventBus events and broadcast to WS clients
    this.unsubscribe = this.bus.on('*', (message) => {
      this.broadcast(message);
    });

    // Periodic ping to detect dead connections
    this.pingInterval = setInterval(() => {
      for (const client of this.clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.ping();
        }
      }
    }, this.config.wsPingIntervalMs);
    this.pingInterval.unref();
  }

  /** Stop broadcasting and clean up all connections. */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    for (const client of this.clients) {
      client.ws.close(1000, 'Server shutting down');
    }
    this.clients.clear();
    this.wss.close();
  }

  /** Number of currently connected WebSocket clients. */
  get clientCount(): number {
    return this.clients.size;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    // Extract agentId from query string (non-sensitive metadata).
    const url = new URL(req.url ?? '/', 'http://localhost');
    const agentIdParam = url.searchParams.get('agentId');

    // Auth via Authorization header in upgrade request (not URL params).
    // Accepts admin token or per-agent token. When using a per-agent token,
    // the URL `agentId` query param must match the authenticated agent.
    let resolvedAgentId: string | null = agentIdParam;
    if (this.config.authEnabled) {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        ws.close(4001, 'Missing Authorization header');
        return;
      }
      const token = authHeader.slice(7);
      const isAdmin = safeCompare(token, this.config.authToken);

      if (!isAdmin) {
        const agent = this.registry.getAgentByToken(token);
        if (!agent) {
          ws.close(4001, 'Invalid auth token');
          return;
        }
        if (agentIdParam && agentIdParam !== agent.id) {
          ws.close(4003, 'Token does not match agentId');
          return;
        }
        resolvedAgentId = agent.id;
      }
    }

    const client: WsClient = {
      ws,
      agentId: resolvedAgentId,
      connectedAt: new Date(),
    };

    this.clients.add(client);

    ws.on('close', () => {
      this.clients.delete(client);
    });

    ws.on('error', (error) => {
      logger.warn('ws', 'Client error', { error: error.message });
      this.clients.delete(client);
    });

    ws.send(JSON.stringify({ type: 'connected', agentId: resolvedAgentId }));
  }

  /**
   * Broadcast a message to all connected WebSocket clients.
   * Skips clients whose send buffer exceeds the high-water mark
   * to prevent unbounded memory growth from slow consumers.
   */
  private broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);

    for (const client of this.clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      // Backpressure: skip slow clients to prevent memory exhaustion
      if (client.ws.bufferedAmount > WS_BUFFER_HIGH_WATER) {
        logger.warn('ws', 'Dropping message to slow client', {
          bufferedAmount: client.ws.bufferedAmount,
        });
        continue;
      }

      client.ws.send(data, (err) => {
        if (err) {
          logger.warn('ws', 'Send error — dropping client', { error: err.message });
          this.clients.delete(client);
          try {
            client.ws.terminate();
          } catch {
            // already terminated
          }
        }
      });
    }
  }
}
