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

import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'node:http';
import type { EventBus } from '../services/event-bus.js';
import type { Config } from '../config.js';
import type { ServerMessage } from '../types.js';

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
  private readonly clients = new Set<WsClient>();
  private unsubscribe: (() => void) | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(server: Server, bus: EventBus, config: Config) {
    this.bus = bus;
    this.config = config;

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
    // Extract agentId from query string (non-sensitive metadata)
    const url = new URL(req.url ?? '/', 'http://localhost');
    const agentIdParam = url.searchParams.get('agentId');

    // Auth via Authorization header in upgrade request (not URL params)
    if (this.config.authEnabled) {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        ws.close(4001, 'Missing Authorization header');
        return;
      }
      const token = authHeader.slice(7);
      const expected = this.config.authToken;
      if (
        token.length !== expected.length ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
      ) {
        ws.close(4001, 'Invalid auth token');
        return;
      }
    }

    const client: WsClient = {
      ws,
      agentId: agentIdParam,
      connectedAt: new Date(),
    };

    this.clients.add(client);

    ws.on('close', () => {
      this.clients.delete(client);
    });

    ws.on('error', (error) => {
      console.error('[WS] Client error:', error.message);
      this.clients.delete(client);
    });

    ws.send(JSON.stringify({ type: 'connected', agentId: agentIdParam }));
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
        console.warn(
          '[WS] Dropping message to slow client (buffered:',
          client.ws.bufferedAmount,
          ')',
        );
        continue;
      }

      client.ws.send(data, (err) => {
        if (err) {
          console.error('[WS] Send error:', err.message);
        }
      });
    }
  }
}
