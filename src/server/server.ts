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
import { MessageService } from '../services/messages.js';
import { createRoutes } from './routes.js';
import {
  authMiddleware,
  errorHandler,
  rateLimitMiddleware,
  strictRedeemRateLimit,
} from './middleware.js';
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
  const messages = new MessageService(store, bus);

  // Wire cross-service dependencies (avoid circular imports)
  registry.setTaskQueue(taskQueue);
  registry.setFileOwnership(fileOwnership);

  // -------------------------------------------------------------------------
  // Express app
  // -------------------------------------------------------------------------

  setLogLevel(config.logLevel);

  const app = express();

  // Don't advertise the framework — small but free defense-in-depth.
  app.disable('x-powered-by');

  // Resolve `req.ip` correctly when behind a reverse proxy. Set 0 (false)
  // to ignore X-Forwarded-For; >0 trusts that many proxy hops.
  app.set('trust proxy', config.trustProxy);

  // Parse JSON bodies. Use `strict: false` so top-level primitives (null,
  // numbers, strings, arrays) parse without throwing — that lets the
  // route's Zod schema return a clean 400 instead of the body-parser
  // raising and falling through to the global 500 handler.
  app.use(express.json({ limit: '1mb', strict: false }));

  // Body-parse error handler — converts SyntaxError / PayloadTooLargeError
  // / unsupported-charset etc. into a JSON 400, instead of letting them
  // reach the global error handler as a 500. Must be registered AFTER
  // express.json() so it sees the parser's errors.
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (err && typeof err === 'object' && 'type' in err) {
        const e = err as { type?: string; status?: number; message?: string };
        if (
          e.type === 'entity.parse.failed' ||
          e.type === 'entity.too.large' ||
          e.type === 'charset.unsupported' ||
          e.type === 'encoding.unsupported'
        ) {
          res.status(400).json({
            error: 'Invalid request body',
            details: e.message ?? 'Body could not be parsed',
          });
          return;
        }
      }
      next(err);
    },
  );

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

  // Rate limiting (global)
  app.use('/api', rateLimitMiddleware(config));

  // Stricter rate limit on the unauthenticated invite-redeem endpoint —
  // 10 attempts / 5 min / IP. The global limiter alone (200/min) lets a
  // brute-force run try thousands of codes per hour.
  app.use('/api/invites/redeem', strictRedeemRateLimit());

  // Auth (applied to /api routes only) — except /api/invites/redeem which
  // is the unauthenticated onboarding entry point (rate-limited above).
  app.use('/api', (req, res, next) => {
    if (req.method === 'POST' && req.path === '/invites/redeem') {
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
    messages,
    store,
    bus,
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
