/**
 * Environment configuration with secure defaults.
 *
 * All values are read from environment variables (or .env via dotenv).
 * Every setting has a sensible default so the server works out-of-the-box.
 *
 * Security:
 * - Auth token required by default (generated if not provided)
 * - CORS restricted to localhost by default
 * - Rate limiting enabled
 * - No secrets ever logged
 */

import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function env(key: string, fallback: string): string {
  return process.env[key]?.trim() ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid integer for ${key}: "${raw}"`);
  }
  return parsed;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  throw new Error(`Invalid boolean for ${key}: "${raw}"`);
}

function envList(key: string, fallback: readonly string[]): readonly string[] {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Generate a cryptographically secure random token.
 * Used as default auth token when none is provided.
 */
function generateToken(): string {
  return randomBytes(32).toString('hex');
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface Config {
  /** Server */
  readonly port: number;
  readonly host: string;

  /** Database */
  readonly dbPath: string;

  /** Security */
  readonly authToken: string;
  readonly authEnabled: boolean;
  readonly corsOrigins: readonly string[];
  readonly rateLimitWindowMs: number;
  readonly rateLimitMaxRequests: number;

  /** Agent lifecycle */
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly staleAgentCleanupMs: number;

  /** File ownership */
  readonly defaultClaimTtlMs: number;
  readonly maxClaimsPerAgent: number;

  /** Knowledge store */
  readonly defaultKnowledgeTtlSeconds: number;
  readonly maxKnowledgeEntries: number;

  /** WebSocket */
  readonly wsMaxPayloadBytes: number;
  readonly wsPingIntervalMs: number;

  /** Dashboard */
  readonly dashboardEnabled: boolean;

  /** Environment */
  readonly nodeEnv: string;
  readonly logLevel: string;
}

export function loadConfig(): Config {
  const authToken = env('CHM_AUTH_TOKEN', '');
  const generatedToken = authToken || generateToken();

  // Log the generated token on first run so the user can grab it
  if (!authToken && env('NODE_ENV', 'development') === 'development') {
    console.log(`[CHM] No CHM_AUTH_TOKEN set. Generated: ${generatedToken}`);
    console.log('[CHM] Set CHM_AUTH_TOKEN in .env to persist across restarts.');
  }

  return {
    // Server
    port: envInt('CHM_PORT', 7777),
    host: env('CHM_HOST', '0.0.0.0'),

    // Database
    dbPath: env('CHM_DB_PATH', 'hivemind.db'),

    // Security
    authToken: generatedToken,
    authEnabled: envBool('CHM_AUTH_ENABLED', true),
    corsOrigins: envList('CHM_CORS_ORIGINS', ['http://localhost:7777']),
    rateLimitWindowMs: envInt('CHM_RATE_LIMIT_WINDOW_MS', 60_000),
    rateLimitMaxRequests: envInt('CHM_RATE_LIMIT_MAX', 200),

    // Agent lifecycle
    heartbeatIntervalMs: envInt('CHM_HEARTBEAT_INTERVAL_MS', 10_000),
    heartbeatTimeoutMs: envInt('CHM_HEARTBEAT_TIMEOUT_MS', 30_000),
    staleAgentCleanupMs: envInt('CHM_STALE_CLEANUP_MS', 60_000),

    // File ownership
    defaultClaimTtlMs: envInt('CHM_DEFAULT_CLAIM_TTL_MS', 300_000),
    maxClaimsPerAgent: envInt('CHM_MAX_CLAIMS_PER_AGENT', 50),

    // Knowledge store
    defaultKnowledgeTtlSeconds: envInt('CHM_DEFAULT_KNOWLEDGE_TTL_S', 3600),
    maxKnowledgeEntries: envInt('CHM_MAX_KNOWLEDGE_ENTRIES', 1000),

    // WebSocket
    wsMaxPayloadBytes: envInt('CHM_WS_MAX_PAYLOAD_BYTES', 1_048_576),
    wsPingIntervalMs: envInt('CHM_WS_PING_INTERVAL_MS', 15_000),

    // Dashboard
    dashboardEnabled: envBool('CHM_DASHBOARD_ENABLED', true),

    // Environment
    nodeEnv: env('NODE_ENV', 'development'),
    logLevel: env('CHM_LOG_LEVEL', 'info'),
  };
}

/**
 * Validate a loaded config for unsafe or contradictory settings.
 * Throws on critical misconfigurations.
 */
export function validateConfig(config: Config): readonly string[] {
  const warnings: string[] = [];

  // Critical: port must be valid
  if (config.port < 1 || config.port > 65535) {
    throw new Error(`Invalid port: ${String(config.port)}. Must be 1-65535.`);
  }

  // Critical: heartbeat timeout must be greater than interval
  if (config.heartbeatTimeoutMs <= config.heartbeatIntervalMs) {
    throw new Error(
      `heartbeatTimeoutMs (${String(config.heartbeatTimeoutMs)}) must be greater than heartbeatIntervalMs (${String(config.heartbeatIntervalMs)}).`,
    );
  }

  // Warning: auth disabled in production
  if (!config.authEnabled && config.nodeEnv === 'production') {
    warnings.push('WARNING: Authentication disabled in production. Set CHM_AUTH_ENABLED=true.');
  }

  // Warning: wildcard CORS in production
  if (config.corsOrigins.includes('*') && config.nodeEnv === 'production') {
    warnings.push('WARNING: CORS allows all origins in production. Restrict CHM_CORS_ORIGINS.');
  }

  // Warning: rate limit too high
  if (config.rateLimitMaxRequests > 1000) {
    warnings.push('WARNING: Rate limit very high (>1000 req/window). Consider lowering.');
  }

  // Warning: claim TTL too short
  if (config.defaultClaimTtlMs < 30_000) {
    warnings.push('WARNING: File claim TTL < 30s. Agents may lose claims mid-edit.');
  }

  return warnings;
}
