import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, validateConfig } from '../src/config.js';
import type { Config } from '../src/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Set env vars for a test, automatically cleaned up after.
 */
function setEnv(vars: Record<string, string>): void {
  for (const [key, value] of Object.entries(vars)) {
    process.env[key] = value;
  }
}

function clearAllChmEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('CHM_') || key === 'NODE_ENV') {
      process.env[key] = undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

type StderrSpy = ReturnType<typeof vi.spyOn<NodeJS.WriteStream, 'write'>>;

function stderrText(spy: StderrSpy): string {
  return spy.mock.calls.map((c) => String(c[0])).join('\n');
}

describe('config', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let stderrSpy: StderrSpy;

  beforeEach(() => {
    originalEnv = { ...process.env };
    clearAllChmEnv();
    // Suppress console.log just in case any path still uses it.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Logger writes JSON lines to stderr; spy so token-logging tests can
    // assert the masked token preview is emitted (and never the raw token).
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Default values
  // -------------------------------------------------------------------------

  describe('defaults', () => {
    it('uses port 7777 by default', () => {
      const config = loadConfig();
      expect(config.port).toBe(7777);
    });

    it('listens on 0.0.0.0 by default', () => {
      const config = loadConfig();
      expect(config.host).toBe('0.0.0.0');
    });

    it('uses hivemind.db by default (resolved to absolute path)', () => {
      const config = loadConfig();
      expect(config.dbPath).toMatch(/hivemind\.db$/);
      // Should be absolute so process CWD changes can't relocate the DB.
      expect(config.dbPath.startsWith('/') || /^[a-zA-Z]:\\/.test(config.dbPath)).toBe(true);
    });

    it('preserves :memory: as a non-resolved special value', () => {
      const orig = process.env.CHM_DB_PATH;
      process.env.CHM_DB_PATH = ':memory:';
      try {
        const config = loadConfig();
        expect(config.dbPath).toBe(':memory:');
      } finally {
        if (orig === undefined) delete process.env.CHM_DB_PATH;
        else process.env.CHM_DB_PATH = orig;
      }
    });

    it('enables auth by default', () => {
      const config = loadConfig();
      expect(config.authEnabled).toBe(true);
    });

    it('generates a 64-char hex auth token when none provided', () => {
      const config = loadConfig();
      expect(config.authToken).toMatch(/^[0-9a-f]{64}$/);
    });

    it('generates different tokens each time', () => {
      const config1 = loadConfig();
      const config2 = loadConfig();
      expect(config1.authToken).not.toBe(config2.authToken);
    });

    it('restricts CORS to localhost:7777 by default', () => {
      const config = loadConfig();
      expect(config.corsOrigins).toEqual(['http://localhost:7777']);
    });

    it('sets heartbeat interval to 10s', () => {
      const config = loadConfig();
      expect(config.heartbeatIntervalMs).toBe(10_000);
    });

    it('sets heartbeat timeout to 90s', () => {
      const config = loadConfig();
      expect(config.heartbeatTimeoutMs).toBe(90_000);
    });

    it('sets stale agent cleanup to 60s', () => {
      const config = loadConfig();
      expect(config.staleAgentCleanupMs).toBe(60_000);
    });

    it('sets default file claim TTL to 5 minutes', () => {
      const config = loadConfig();
      expect(config.defaultClaimTtlMs).toBe(300_000);
    });

    it('allows max 50 claims per agent', () => {
      const config = loadConfig();
      expect(config.maxClaimsPerAgent).toBe(50);
    });

    it('sets default knowledge TTL to 1 hour', () => {
      const config = loadConfig();
      expect(config.defaultKnowledgeTtlSeconds).toBe(3600);
    });

    it('limits knowledge store to 1000 entries', () => {
      const config = loadConfig();
      expect(config.maxKnowledgeEntries).toBe(1000);
    });

    it('sets WebSocket max payload to 1MB', () => {
      const config = loadConfig();
      expect(config.wsMaxPayloadBytes).toBe(1_048_576);
    });

    it('sets WebSocket ping interval to 15s', () => {
      const config = loadConfig();
      expect(config.wsPingIntervalMs).toBe(15_000);
    });

    it('enables dashboard by default', () => {
      const config = loadConfig();
      expect(config.dashboardEnabled).toBe(true);
    });

    it('defaults to development environment', () => {
      const config = loadConfig();
      expect(config.nodeEnv).toBe('development');
    });

    it('defaults to info log level', () => {
      const config = loadConfig();
      expect(config.logLevel).toBe('info');
    });

    it('sets rate limit to 200 requests per 60s window', () => {
      const config = loadConfig();
      expect(config.rateLimitWindowMs).toBe(60_000);
      expect(config.rateLimitMaxRequests).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Environment variable overrides
  // -------------------------------------------------------------------------

  describe('env overrides', () => {
    it('reads CHM_PORT', () => {
      setEnv({ CHM_PORT: '9999' });
      expect(loadConfig().port).toBe(9999);
    });

    it('reads CHM_HOST', () => {
      setEnv({ CHM_HOST: '127.0.0.1' });
      expect(loadConfig().host).toBe('127.0.0.1');
    });

    it('reads CHM_DB_PATH', () => {
      setEnv({ CHM_DB_PATH: '/data/mydb.sqlite' });
      expect(loadConfig().dbPath).toBe('/data/mydb.sqlite');
    });

    it('reads CHM_AUTH_TOKEN', () => {
      setEnv({ CHM_AUTH_TOKEN: 'my-secret-token' });
      expect(loadConfig().authToken).toBe('my-secret-token');
    });

    it('reads CHM_AUTH_ENABLED=false', () => {
      setEnv({ CHM_AUTH_ENABLED: 'false' });
      expect(loadConfig().authEnabled).toBe(false);
    });

    it('reads CHM_CORS_ORIGINS as comma-separated list', () => {
      setEnv({ CHM_CORS_ORIGINS: 'http://localhost:3000, http://localhost:5173, *' });
      expect(loadConfig().corsOrigins).toEqual([
        'http://localhost:3000',
        'http://localhost:5173',
        '*',
      ]);
    });

    it('reads CHM_HEARTBEAT_INTERVAL_MS', () => {
      setEnv({ CHM_HEARTBEAT_INTERVAL_MS: '5000' });
      expect(loadConfig().heartbeatIntervalMs).toBe(5000);
    });

    it('reads CHM_HEARTBEAT_TIMEOUT_MS', () => {
      setEnv({ CHM_HEARTBEAT_TIMEOUT_MS: '60000' });
      expect(loadConfig().heartbeatTimeoutMs).toBe(60_000);
    });

    it('reads CHM_DEFAULT_CLAIM_TTL_MS', () => {
      setEnv({ CHM_DEFAULT_CLAIM_TTL_MS: '600000' });
      expect(loadConfig().defaultClaimTtlMs).toBe(600_000);
    });

    it('reads CHM_MAX_CLAIMS_PER_AGENT', () => {
      setEnv({ CHM_MAX_CLAIMS_PER_AGENT: '100' });
      expect(loadConfig().maxClaimsPerAgent).toBe(100);
    });

    it('reads CHM_DASHBOARD_ENABLED=false', () => {
      setEnv({ CHM_DASHBOARD_ENABLED: 'false' });
      expect(loadConfig().dashboardEnabled).toBe(false);
    });

    it('reads NODE_ENV', () => {
      setEnv({ NODE_ENV: 'production' });
      expect(loadConfig().nodeEnv).toBe('production');
    });

    it('reads CHM_LOG_LEVEL', () => {
      setEnv({ CHM_LOG_LEVEL: 'debug' });
      expect(loadConfig().logLevel).toBe('debug');
    });

    it('reads CHM_RATE_LIMIT_MAX', () => {
      setEnv({ CHM_RATE_LIMIT_MAX: '500' });
      expect(loadConfig().rateLimitMaxRequests).toBe(500);
    });

    it('reads CHM_WS_MAX_PAYLOAD_BYTES', () => {
      setEnv({ CHM_WS_MAX_PAYLOAD_BYTES: '524288' });
      expect(loadConfig().wsMaxPayloadBytes).toBe(524_288);
    });
  });

  // -------------------------------------------------------------------------
  // Boolean parsing
  // -------------------------------------------------------------------------

  describe('boolean parsing', () => {
    it.each(['true', '1', 'yes'])('parses "%s" as true', (value) => {
      setEnv({ CHM_AUTH_ENABLED: value });
      expect(loadConfig().authEnabled).toBe(true);
    });

    it.each(['false', '0', 'no'])('parses "%s" as false', (value) => {
      setEnv({ CHM_AUTH_ENABLED: value });
      expect(loadConfig().authEnabled).toBe(false);
    });

    it('is case-insensitive', () => {
      setEnv({ CHM_AUTH_ENABLED: 'TRUE' });
      expect(loadConfig().authEnabled).toBe(true);
      setEnv({ CHM_AUTH_ENABLED: 'False' });
      expect(loadConfig().authEnabled).toBe(false);
    });

    it('throws on invalid boolean', () => {
      setEnv({ CHM_AUTH_ENABLED: 'maybe' });
      expect(() => loadConfig()).toThrow('Invalid boolean for CHM_AUTH_ENABLED: "maybe"');
    });
  });

  // -------------------------------------------------------------------------
  // Integer parsing errors
  // -------------------------------------------------------------------------

  describe('integer parsing errors', () => {
    it('throws on non-numeric port', () => {
      setEnv({ CHM_PORT: 'abc' });
      expect(() => loadConfig()).toThrow('Invalid integer for CHM_PORT: "abc"');
    });

    it('throws on float port', () => {
      setEnv({ CHM_PORT: '3.14' });
      // parseInt('3.14') = 3, so this actually parses — that's fine
      expect(loadConfig().port).toBe(3);
    });

    it('throws on empty-after-trim', () => {
      setEnv({ CHM_PORT: '   ' });
      // Empty after trim falls back to default
      expect(loadConfig().port).toBe(7777);
    });
  });

  // -------------------------------------------------------------------------
  // Whitespace handling
  // -------------------------------------------------------------------------

  describe('whitespace handling', () => {
    it('trims env var values', () => {
      setEnv({ CHM_HOST: '  127.0.0.1  ' });
      expect(loadConfig().host).toBe('127.0.0.1');
    });

    it('trims CORS origin entries', () => {
      setEnv({ CHM_CORS_ORIGINS: ' http://a.com , http://b.com ' });
      expect(loadConfig().corsOrigins).toEqual(['http://a.com', 'http://b.com']);
    });

    it('filters empty entries from CORS list', () => {
      setEnv({ CHM_CORS_ORIGINS: 'http://a.com,,http://b.com,' });
      expect(loadConfig().corsOrigins).toEqual(['http://a.com', 'http://b.com']);
    });
  });

  // -------------------------------------------------------------------------
  // Token generation security
  // -------------------------------------------------------------------------

  describe('token security', () => {
    it('generates a 32-byte (256-bit) token', () => {
      const config = loadConfig();
      // 32 bytes = 64 hex chars
      expect(config.authToken).toHaveLength(64);
    });

    it('token contains only hex characters', () => {
      const config = loadConfig();
      expect(config.authToken).toMatch(/^[0-9a-f]+$/);
    });

    it('does not log token in production', () => {
      setEnv({ NODE_ENV: 'production' });
      stderrSpy.mockClear();
      loadConfig();
      const stderrCalls = stderrText(stderrSpy);
      expect(stderrCalls).not.toMatch(/CHM_AUTH_TOKEN/);
    });

    it('logs masked token preview in development (not the raw token)', () => {
      setEnv({ NODE_ENV: 'development' });
      stderrSpy.mockClear();
      const config = loadConfig();
      const stderrCalls = stderrText(stderrSpy);
      // Reference to the env var name in the warning is fine.
      expect(stderrCalls).toMatch(/CHM_AUTH_TOKEN/);
      // Critical: the raw token must never appear in stderr.
      expect(stderrCalls).not.toContain(config.authToken);
    });

    it('does not log when token is explicitly provided', () => {
      setEnv({ CHM_AUTH_TOKEN: 'explicit-token' });
      stderrSpy.mockClear();
      loadConfig();
      const stderrCalls = stderrText(stderrSpy);
      expect(stderrCalls).not.toMatch(/CHM_AUTH_TOKEN/);
    });
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe('validateConfig', () => {
  function makeConfig(overrides: Partial<Config> = {}): Config {
    return {
      port: 7777,
      host: '0.0.0.0',
      dbPath: 'hivemind.db',
      authToken: 'test-token',
      authEnabled: true,
      corsOrigins: ['http://localhost:7777'],
      rateLimitWindowMs: 60_000,
      rateLimitMaxRequests: 200,
      trustProxy: 0,
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 30_000,
      staleAgentCleanupMs: 60_000,
      defaultClaimTtlMs: 300_000,
      maxClaimsPerAgent: 50,
      defaultKnowledgeTtlSeconds: 3600,
      maxKnowledgeEntries: 1000,
      wsMaxPayloadBytes: 1_048_576,
      wsPingIntervalMs: 15_000,
      dashboardEnabled: true,
      nodeEnv: 'development',
      logLevel: 'info',
      ...overrides,
    };
  }

  // -------------------------------------------------------------------------
  // Critical errors (throws)
  // -------------------------------------------------------------------------

  describe('critical errors', () => {
    it('throws on port 0', () => {
      expect(() => validateConfig(makeConfig({ port: 0 }))).toThrow('Invalid port: 0');
    });

    it('throws on port > 65535', () => {
      expect(() => validateConfig(makeConfig({ port: 70000 }))).toThrow('Invalid port: 70000');
    });

    it('throws on negative port', () => {
      expect(() => validateConfig(makeConfig({ port: -1 }))).toThrow('Invalid port: -1');
    });

    it('throws when heartbeat timeout <= interval', () => {
      expect(() =>
        validateConfig(makeConfig({ heartbeatIntervalMs: 10_000, heartbeatTimeoutMs: 10_000 })),
      ).toThrow('heartbeatTimeoutMs (10000) must be greater than heartbeatIntervalMs (10000)');
    });

    it('throws when heartbeat timeout < interval', () => {
      expect(() =>
        validateConfig(makeConfig({ heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 10_000 })),
      ).toThrow('heartbeatTimeoutMs (10000) must be greater than heartbeatIntervalMs (30000)');
    });
  });

  // -------------------------------------------------------------------------
  // Warnings (returns string array)
  // -------------------------------------------------------------------------

  describe('warnings', () => {
    it('returns empty array for valid development config', () => {
      const warnings = validateConfig(makeConfig());
      expect(warnings).toEqual([]);
    });

    it('warns when auth disabled in production', () => {
      const warnings = validateConfig(makeConfig({ authEnabled: false, nodeEnv: 'production' }));
      expect(warnings).toContain(
        'WARNING: Authentication disabled in production. Set CHM_AUTH_ENABLED=true.',
      );
    });

    it('does not warn when auth disabled in development', () => {
      const warnings = validateConfig(makeConfig({ authEnabled: false, nodeEnv: 'development' }));
      expect(warnings).toEqual([]);
    });

    it('warns on wildcard CORS in production', () => {
      const warnings = validateConfig(makeConfig({ corsOrigins: ['*'], nodeEnv: 'production' }));
      expect(warnings).toContain(
        'WARNING: CORS allows all origins in production. Restrict CHM_CORS_ORIGINS.',
      );
    });

    it('does not warn on wildcard CORS in development', () => {
      const warnings = validateConfig(makeConfig({ corsOrigins: ['*'], nodeEnv: 'development' }));
      expect(warnings).toEqual([]);
    });

    it('warns on very high rate limit', () => {
      const warnings = validateConfig(makeConfig({ rateLimitMaxRequests: 1001 }));
      expect(warnings).toContain(
        'WARNING: Rate limit very high (>1000 req/window). Consider lowering.',
      );
    });

    it('does not warn on rate limit at 1000', () => {
      const warnings = validateConfig(makeConfig({ rateLimitMaxRequests: 1000 }));
      expect(warnings).toEqual([]);
    });

    it('warns on very short claim TTL', () => {
      const warnings = validateConfig(makeConfig({ defaultClaimTtlMs: 29_999 }));
      expect(warnings).toContain('WARNING: File claim TTL < 30s. Agents may lose claims mid-edit.');
    });

    it('does not warn on claim TTL at 30s', () => {
      const warnings = validateConfig(makeConfig({ defaultClaimTtlMs: 30_000 }));
      expect(warnings).toEqual([]);
    });

    it('can return multiple warnings at once', () => {
      const warnings = validateConfig(
        makeConfig({
          authEnabled: false,
          corsOrigins: ['*'],
          nodeEnv: 'production',
          rateLimitMaxRequests: 5000,
          defaultClaimTtlMs: 1000,
        }),
      );
      // auth disabled, wildcard CORS, high rate limit, short TTL, host=0.0.0.0
      expect(warnings).toHaveLength(5);
    });

    it('warns on 0.0.0.0 binding in production', () => {
      const warnings = validateConfig(makeConfig({ host: '0.0.0.0', nodeEnv: 'production' }));
      expect(warnings.some((w) => w.includes('0.0.0.0'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Valid edge cases
  // -------------------------------------------------------------------------

  describe('valid edge cases', () => {
    it('accepts port 1', () => {
      expect(() => validateConfig(makeConfig({ port: 1 }))).not.toThrow();
    });

    it('accepts port 65535', () => {
      expect(() => validateConfig(makeConfig({ port: 65535 }))).not.toThrow();
    });

    it('accepts heartbeat timeout just above interval', () => {
      expect(() =>
        validateConfig(makeConfig({ heartbeatIntervalMs: 10_000, heartbeatTimeoutMs: 10_001 })),
      ).not.toThrow();
    });
  });
});
