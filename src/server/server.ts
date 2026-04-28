/**
 * Main server assembly — wires everything together.
 *
 * Creates the Express app, configures middleware, attaches routes,
 * starts WebSocket handler, and manages the service lifecycle.
 */

import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { Config } from '../config.js';
import { Store } from '../services/store.js';
import { EventBus } from '../services/event-bus.js';
import { AgentRegistry } from '../services/agent-registry.js';
import { FileOwnershipService } from '../services/file-ownership.js';
import { TaskQueue } from '../services/task-queue.js';
import { KnowledgeStore } from '../services/knowledge-store.js';
import { DecisionLog } from '../services/decision-log.js';
import { ConflictDetector } from '../services/conflict-detector.js';
import { createRoutes } from './routes.js';
import { authMiddleware, rateLimitMiddleware, errorHandler } from './middleware.js';
import { WsHandler } from './ws-handler.js';

export interface HiveMindServer {
  readonly httpServer: Server;
  readonly store: Store;
  readonly bus: EventBus;
  readonly registry: AgentRegistry;
  readonly wsHandler: WsHandler;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createHiveMindServer(config: Config): HiveMindServer {
  // -------------------------------------------------------------------------
  // Services
  // -------------------------------------------------------------------------

  const store = new Store(config.dbPath);
  const bus = new EventBus();
  const registry = new AgentRegistry(store, bus, config);
  const fileOwnership = new FileOwnershipService(store, bus, config);
  const taskQueue = new TaskQueue(store, bus);
  const knowledge = new KnowledgeStore(store, bus, config);
  const decisions = new DecisionLog(store, bus);
  const conflicts = new ConflictDetector(store, bus);

  // -------------------------------------------------------------------------
  // Express app
  // -------------------------------------------------------------------------

  const app = express();

  // Parse JSON bodies
  app.use(express.json({ limit: '1mb' }));

  // CORS
  app.use(
    cors({
      origin: [...config.corsOrigins],
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }),
  );

  // Health check (before auth — must be publicly accessible)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: '0.1.0' });
  });

  // Rate limiting
  app.use('/api', rateLimitMiddleware(config));

  // Auth (applied to /api routes only)
  app.use('/api', authMiddleware(config));

  // API routes
  const routes = createRoutes({
    registry,
    fileOwnership,
    taskQueue,
    knowledge,
    decisions,
    conflicts,
  });
  app.use(routes);

  // Error handler (must be last)
  app.use(errorHandler);

  // -------------------------------------------------------------------------
  // HTTP + WebSocket server
  // -------------------------------------------------------------------------

  const httpServer = createServer(app);
  const wsHandler = new WsHandler(httpServer, bus, config);

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  return {
    httpServer,
    store,
    bus,
    registry,
    wsHandler,

    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        // Start cleanup intervals
        registry.startCleanupInterval();

        // Start WS broadcasting
        wsHandler.start();

        // Start HTTP server
        httpServer.listen(config.port, config.host, () => {
          console.log(
            `[HiveMind] Server listening on http://${config.host}:${String(config.port)}`,
          );
          console.log(`[HiveMind] WebSocket at ws://${config.host}:${String(config.port)}/ws`);
          if (config.authEnabled) {
            console.log('[HiveMind] Auth enabled — use Bearer token to connect');
          } else {
            console.log('[HiveMind] Auth disabled — open access');
          }
          resolve();
        });

        httpServer.on('error', reject);
      });
    },

    stop(): Promise<void> {
      return new Promise((resolve) => {
        registry.stopCleanupInterval();
        wsHandler.stop();
        bus.clear();
        httpServer.close(() => {
          store.close();
          resolve();
        });
      });
    },
  };
}
