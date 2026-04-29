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
import { InviteService } from '../services/invites.js';
import { createRoutes } from './routes.js';
import { authMiddleware, rateLimitMiddleware, errorHandler } from './middleware.js';
import { WsHandler } from './ws-handler.js';
import { logger, setLogLevel } from '../util/logger.js';

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
  const invites = new InviteService(store);

  // Wire cross-service dependency (avoids circular import)
  registry.setTaskQueue(taskQueue);

  // -------------------------------------------------------------------------
  // Express app
  // -------------------------------------------------------------------------

  setLogLevel(config.logLevel);

  const app = express();

  // Resolve `req.ip` correctly when behind a reverse proxy. Set 0 (false)
  // to ignore X-Forwarded-For; >0 trusts that many proxy hops.
  app.set('trust proxy', config.trustProxy);

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

  // Hardening headers (cheap and broadly applicable)
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // Health check (before auth — must be publicly accessible)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: '0.1.0' });
  });

  // Rate limiting
  app.use('/api', rateLimitMiddleware(config));

  // Auth (applied to /api routes only) — except /api/invites/redeem which
  // is the unauthenticated onboarding entry point (rate-limited heavily).
  app.use('/api', (req, res, next) => {
    if (req.method === 'POST' && req.path === '/invites/redeem') {
      // Skip auth for this single endpoint.
      next();
      return;
    }
    authMiddleware(config, registry, invites)(req, res, next);
  });

  // API routes
  const routes = createRoutes({
    registry,
    fileOwnership,
    taskQueue,
    knowledge,
    decisions,
    conflicts,
    invites,
  });
  app.use(routes);

  // JSON 404 for any path that didn't match a route. Without this, Express
  // falls back to its default HTML 404 page which leaks server internals
  // and breaks API clients that always parse JSON.
  app.use((req, res) => {
    res.status(404).json({ error: 'Route not found', path: req.path });
  });

  // Error handler (must be last)
  app.use(errorHandler);

  // -------------------------------------------------------------------------
  // HTTP + WebSocket server
  // -------------------------------------------------------------------------

  const httpServer = createServer(app);
  const wsHandler = new WsHandler(httpServer, bus, config, registry);

  // Background timers (stopped in stop()).
  const cleanupTimers: NodeJS.Timeout[] = [];

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

        // Periodically expire claimed files past their TTL.
        cleanupTimers.push(
          setInterval(() => {
            try {
              fileOwnership.cleanupExpired();
            } catch (err: unknown) {
              logger.error('cleanup', 'fileOwnership.cleanupExpired failed', {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }, config.staleAgentCleanupMs).unref(),
        );

        // Periodically expire knowledge entries past their TTL.
        cleanupTimers.push(
          setInterval(() => {
            try {
              knowledge.cleanupExpired();
            } catch (err: unknown) {
              logger.error('cleanup', 'knowledge.cleanupExpired failed', {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }, config.staleAgentCleanupMs).unref(),
        );

        // Periodically drop expired-but-unused invites.
        cleanupTimers.push(
          setInterval(() => {
            try {
              invites.cleanupExpired();
            } catch (err: unknown) {
              logger.error('cleanup', 'invites.cleanupExpired failed', {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }, config.staleAgentCleanupMs).unref(),
        );

        // Start WS broadcasting
        wsHandler.start();

        // Start HTTP server
        httpServer.listen(config.port, config.host, () => {
          logger.info('server', 'HTTP listening', {
            url: `http://${config.host}:${String(config.port)}`,
            ws: `ws://${config.host}:${String(config.port)}/ws`,
            authEnabled: config.authEnabled,
          });
          resolve();
        });

        httpServer.on('error', reject);
      });
    },

    stop(): Promise<void> {
      return new Promise((resolve) => {
        registry.stopCleanupInterval();
        for (const t of cleanupTimers) clearInterval(t);
        cleanupTimers.length = 0;
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
