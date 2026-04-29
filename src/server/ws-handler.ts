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
import type { AgentRecord, ServerMessage } from '../types.js';
import type { AgentRegistry } from '../services/agent-registry.js';
import { logger } from '../util/logger.js';
import { safeCompare } from './middleware.js';

/** High-water mark for WS send buffer (256KB). */
const WS_BUFFER_HIGH_WATER = 256 * 1024;

export interface WsClient {
  readonly ws: WebSocket;
  readonly agentId: string | null;
  /** True iff the client authenticated with the admin token. */
  readonly isAdmin: boolean;
  readonly connectedAt: Date;
}

/** Strip workspace_path and repo_url from an agent record. */
function stripSensitiveAgentFields(agent: AgentRecord): AgentRecord {
  return { ...agent, workspacePath: '', repoUrl: null };
}

/**
 * Return a per-client variant of a broadcast message: events that carry an
 * AgentRecord get its workspacePath/repoUrl stripped when the recipient is
 * not the admin and not the agent itself.
 */
function messageForClient(message: ServerMessage, client: WsClient): ServerMessage {
  if (client.isAdmin) return message;

  if (message.type === 'agent_joined') {
    if (client.agentId === message.agent.id) return message;
    return { type: 'agent_joined', agent: stripSensitiveAgentFields(message.agent) };
  }

  if (message.type === 'state_sync') {
    return {
      type: 'state_sync',
      state: {
        ...message.state,
        agents: message.state.agents.map((a) =>
          a.id === client.agentId ? a : stripSensitiveAgentFields(a),
        ),
      },
    };
  }

  return message;
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

    // Auth via Authorization header in upgrade request OR ?token= query
    // param (browsers can't set custom WS headers, so the dashboard uses
    // the query form). Accepts admin or per-agent token.
    //
    // In 'open' read-access mode, an unauthenticated subscriber is also
    // allowed — they receive the same sanitized event stream that any
    // anonymous /api/state caller would see.
    let resolvedAgentId: string | null = agentIdParam;
    let isAdmin = !this.config.authEnabled;
    if (this.config.authEnabled) {
      const authHeader = req.headers.authorization;
      const queryToken = url.searchParams.get('token');
      let token: string | null = null;
      if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.slice(7);
      } else if (queryToken && queryToken.length > 0) {
        token = queryToken;
      }

      if (token === null) {
        if (this.config.readAccess === 'open') {
          // Anonymous read-only subscriber.
          isAdmin = false;
          resolvedAgentId = null;
        } else {
          ws.close(4001, 'Missing Authorization header or ?token= query');
          return;
        }
      } else {
        isAdmin = safeCompare(token, this.config.authToken);
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
    }

    const client: WsClient = {
      ws,
      agentId: resolvedAgentId,
      isAdmin,
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
   *
   * Each client receives a per-recipient variant: agent_joined and
   * state_sync events get their workspace/repo fields stripped before
   * being sent to non-admin clients. The shared admin payload is cached
   * to avoid serializing it once per admin.
   */
  private broadcast(message: ServerMessage): void {
    let adminData: string | null = null;

    for (const client of this.clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      // Backpressure: skip slow clients to prevent memory exhaustion
      if (client.ws.bufferedAmount > WS_BUFFER_HIGH_WATER) {
        logger.warn('ws', 'Dropping message to slow client', {
          bufferedAmount: client.ws.bufferedAmount,
        });
        continue;
      }

      let data: string;
      if (client.isAdmin) {
        adminData ??= JSON.stringify(message);
        data = adminData;
      } else {
        data = JSON.stringify(messageForClient(message, client));
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
