/**
 * WebSocket upgrade auth tests.
 *
 * Verifies the per-agent token + agentId-mismatch path that closes the
 * upgrade with 4003. Pure HTTP routes can't exercise this because the
 * auth check lives inside `WsHandler.handleConnection`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { HiveMindServer } from '../../src/server/server.js';
import { createHiveMindServer } from '../../src/server/server.js';
import type { Config } from '../../src/config.js';

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    dbPath: ':memory:',
    authToken: 'admin-secret',
    authEnabled: true,
    corsOrigins: ['*'],
    rateLimitWindowMs: 60_000,
    rateLimitMaxRequests: 1000,
    trustProxy: 0,
    readAccess: 'required',
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
    staleAgentCleanupMs: 60_000,
    defaultClaimTtlMs: 300_000,
    maxClaimsPerAgent: 50,
    defaultKnowledgeTtlSeconds: 3600,
    maxKnowledgeEntries: 1000,
    wsMaxPayloadBytes: 1_048_576,
    wsPingIntervalMs: 15_000,
    dashboardEnabled: false,
    nodeEnv: 'test',
    logLevel: 'error',
    ...overrides,
  };
}

function port(server: HiveMindServer): number {
  const addr = server.httpServer.address();
  if (typeof addr === 'string' || !addr) throw new Error('Server not listening');
  return addr.port;
}

async function registerAgent(
  base: string,
  name: string,
  adminToken: string,
): Promise<{ id: string; agentToken: string }> {
  const res = await fetch(`${base}/api/agents/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      displayName: name,
      tool: 'claude-code',
      workspacePath: `/test/${name}`,
    }),
  });
  return (await res.json()) as { id: string; agentToken: string };
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on('close', (code: number, reason: Buffer) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

describe('WebSocket auth', () => {
  let server: HiveMindServer;
  let httpBase: string;
  let wsBase: string;

  beforeEach(async () => {
    server = createHiveMindServer(testConfig());
    await server.start();
    const p = port(server);
    httpBase = `http://127.0.0.1:${String(p)}`;
    wsBase = `ws://127.0.0.1:${String(p)}/ws`;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('rejects upgrade without Authorization header (4001)', async () => {
    const ws = new WebSocket(wsBase);
    const { code } = await waitForClose(ws);
    expect(code).toBe(4001);
  });

  it('rejects upgrade with invalid token (4001)', async () => {
    const ws = new WebSocket(wsBase, {
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    const { code } = await waitForClose(ws);
    expect(code).toBe(4001);
  });

  it('accepts upgrade with admin token', async () => {
    const ws = new WebSocket(wsBase, {
      headers: { Authorization: 'Bearer admin-secret' },
    });
    const opened = await new Promise<boolean>((resolve) => {
      ws.on('open', () => {
        ws.close();
        resolve(true);
      });
      ws.on('error', () => {
        resolve(false);
      });
    });
    expect(opened).toBe(true);
  });

  it('accepts upgrade with valid per-agent token', async () => {
    const a = await registerAgent(httpBase, 'A', 'admin-secret');
    const ws = new WebSocket(`${wsBase}?agentId=${a.id}`, {
      headers: { Authorization: `Bearer ${a.agentToken}` },
    });
    const opened = await new Promise<boolean>((resolve) => {
      ws.on('open', () => {
        ws.close();
        resolve(true);
      });
      ws.on('error', () => {
        resolve(false);
      });
    });
    expect(opened).toBe(true);
  });

  it('closes with 4003 when per-agent token does not match agentId param', async () => {
    const a = await registerAgent(httpBase, 'A2', 'admin-secret');
    const b = await registerAgent(httpBase, 'B2', 'admin-secret');
    // Connect with B's id but A's token.
    const ws = new WebSocket(`${wsBase}?agentId=${b.id}`, {
      headers: { Authorization: `Bearer ${a.agentToken}` },
    });
    const { code } = await waitForClose(ws);
    expect(code).toBe(4003);
  });
});
