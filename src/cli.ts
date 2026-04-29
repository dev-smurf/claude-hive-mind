#!/usr/bin/env node
/**
 * CLI entry point for Claude Hive Mind.
 *
 * Commands:
 *   serve            — Start the central coordination server
 *   connect          — Start an MCP stdio bridge (deferred-connect by default)
 *   invite           — Mint a new join code (admin or peer)
 *   join <url>       — Redeem an invite, save credentials for this machine
 *   hives            — Manage saved hives (list / remove)
 *   invites          — Manage outstanding invites (list / revoke)
 */

import os from 'node:os';
import { Command } from 'commander';
import { loadConfig, validateConfig } from './config.js';
import { createHiveMindServer } from './server/server.js';
import { startStdioServer } from './mcp/stdio-server.js';
import { logger, setLogLevel } from './util/logger.js';
import {
  addHive,
  formatInviteUrl,
  listHives,
  parseInviteUrl,
  removeHive,
} from './util/credentials.js';

/**
 * Default display name = device hostname so teammates can tell whose box is
 * connected. Strips Apple's `.local` suffix; falls back if hostname is empty.
 */
function defaultDisplayName(): string {
  const raw = os.hostname().trim();
  if (!raw) return 'Unnamed Agent';
  return raw.replace(/\.local$/i, '');
}

const program = new Command();

program
  .name('claude-hive-mind')
  .description('Real-time coordination layer for multiple AI coding assistants')
  .version('0.1.0');

// ---------------------------------------------------------------------------
// serve — start the central server
// ---------------------------------------------------------------------------

program
  .command('serve')
  .description('Start the central coordination server')
  .option('-p, --port <port>', 'Port to listen on', '7777')
  .option('-h, --host <host>', 'Host to bind to', '0.0.0.0')
  .option('--db <path>', 'SQLite database path', 'hive-mind.db')
  .option('--no-auth', 'Disable authentication')
  .action(async (opts: { port: string; host: string; db: string; auth: boolean }) => {
    if (opts.port) process.env.CHM_PORT = opts.port;
    if (opts.host) process.env.CHM_HOST = opts.host;
    if (opts.db) process.env.CHM_DB_PATH = opts.db;
    if (!opts.auth) process.env.CHM_AUTH_ENABLED = 'false';

    const config = loadConfig();
    setLogLevel(config.logLevel);

    for (const warning of validateConfig(config)) {
      logger.warn('config', warning);
    }

    const server = createHiveMindServer(config);

    const shutdown = async (): Promise<void> => {
      logger.info('cli', 'Shutting down');
      await server.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());

    await server.start();

    // Friendly startup banner with the URL teammates need.
    process.stdout.write(`
╭───────────────────────────────────────────────────────╮
│  Claude Hive Mind is running                          │
│                                                       │
│  Server   : http://${config.host.padEnd(15)}:${String(config.port).padEnd(5)}             │
│  Dashboard: http://${config.host.padEnd(15)}:${String(config.port).padEnd(5)}             │
│                                                       │
│  Invite a teammate:                                   │
│    claude-hive-mind invite                            │
╰───────────────────────────────────────────────────────╯
`);
  });

// ---------------------------------------------------------------------------
// invite — mint a new invite code
// ---------------------------------------------------------------------------

program
  .command('invite')
  .description('Mint an invite code for a new teammate')
  .option(
    '-s, --server <url>',
    'Server URL (default: http://localhost:7777)',
    'http://localhost:7777',
  )
  .option('-l, --label <label>', 'Optional label (e.g. "Felix\'s laptop")')
  .option('--ttl <minutes>', 'Time-to-live in minutes', '10')
  .option('--token <token>', 'Auth token (falls back to CHM_AUTH_TOKEN env var)')
  .action(async (opts: { server: string; label?: string; ttl: string; token?: string }) => {
    const token = opts.token ?? process.env.CHM_AUTH_TOKEN;
    if (!token) {
      process.stderr.write(
        'No auth token. Pass --token <X> or set CHM_AUTH_TOKEN.\n' +
          'If you are an agent (peer), use the agent token from your saved hive.\n',
      );
      process.exit(1);
    }

    const ttlMs = Math.max(1, parseInt(opts.ttl, 10)) * 60 * 1000;
    const body = JSON.stringify({
      ...(opts.label !== undefined ? { label: opts.label } : {}),
      ttlMs,
    });

    const res = await fetch(`${opts.server}/api/invites`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      process.stderr.write(`Failed to create invite (${String(res.status)}): ${text}\n`);
      process.exit(1);
    }
    const data = (await res.json()) as { code: string; expiresAt: string };
    const url = formatInviteUrl(opts.server, data.code);
    const ttlMin = Math.round(ttlMs / 60_000);

    process.stdout.write(`
┌─────────────────────────────────────────────────────────┐
│  Invite created${opts.label ? ` for ${opts.label}` : ''}                                        │
│                                                         │
│  Code:  ${data.code.padEnd(48)}│
│  URL:   ${url.padEnd(48)}│
│                                                         │
│  Share with your teammate. They run:                   │
│    claude-hive-mind join ${url.padEnd(28)}│
│                                                         │
│  Expires in ${String(ttlMin).padEnd(2)} min. Single use.                       │
└─────────────────────────────────────────────────────────┘
`);
  });

// ---------------------------------------------------------------------------
// join — redeem an invite, save credentials for this machine
// ---------------------------------------------------------------------------

program
  .command('join <url-or-code>')
  .description('Redeem an invite and save the join token for this machine')
  .option('-n, --name <name>', 'Short name for this hive (default: derived from host)')
  .option('--server <url>', 'Server URL if you only have a code (no chm:// URL)')
  .action(async (urlOrCode: string, opts: { name?: string; server?: string }) => {
    let serverUrl: string;
    let code: string;

    const parsed = parseInviteUrl(urlOrCode);
    if (parsed) {
      serverUrl = parsed.url;
      code = parsed.code;
    } else {
      // Treat as bare code; need --server.
      if (!opts.server) {
        process.stderr.write(
          'Bare invite code requires --server <url>.\n' +
            'Or pass the full URL like chm://10.0.0.147:7777#A4F2-9E7K\n',
        );
        process.exit(1);
      }
      serverUrl = opts.server;
      code = urlOrCode;
    }

    const res = await fetch(`${serverUrl}/api/invites/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) {
      const text = await res.text();
      process.stderr.write(`Failed to redeem (${String(res.status)}): ${text}\n`);
      process.exit(1);
    }
    const data = (await res.json()) as {
      joinToken: string;
      joinTokenId: string;
      label: string | null;
    };

    // Derive a hive name from the host part if not given.
    const name = opts.name ?? new URL(serverUrl).hostname.split('.')[0] ?? 'hive';

    await addHive({
      name,
      url: serverUrl,
      joinToken: data.joinToken,
      joinTokenId: data.joinTokenId,
      ...(data.label !== null ? { label: data.label } : {}),
    });

    process.stdout.write(`
✓ Joined hive '${name}'
  Server     : ${serverUrl}
  Saved to   : ~/.claude-hive-mind/credentials.json
  Dashboard  : ${serverUrl}

Next: open Claude Code (or any MCP-compatible tool) and call:
  hive_connect("${name}")

Only the sessions where you call hive_connect will join the hive.
`);
  });

// ---------------------------------------------------------------------------
// hives — manage saved hives
// ---------------------------------------------------------------------------

const hivesCmd = program.command('hives').description('Manage saved hives on this machine');

hivesCmd
  .command('list')
  .description('List saved hives')
  .action(async () => {
    const list = await listHives();
    if (list.length === 0) {
      process.stdout.write('No hives saved. Run `claude-hive-mind join <url>` to add one.\n');
      return;
    }
    for (const { name, entry } of list) {
      const last = entry.lastUsedAt ?? '(never used)';
      process.stdout.write(
        `  ${name.padEnd(20)} ${entry.url.padEnd(35)} ${entry.label ?? ''}\n` +
          `  ${' '.repeat(20)} added ${entry.addedAt}, last used ${last}\n\n`,
      );
    }
  });

hivesCmd
  .command('remove <name>')
  .description('Remove a saved hive')
  .action(async (name: string) => {
    const ok = await removeHive(name);
    if (!ok) {
      process.stderr.write(`No hive named '${name}' is saved.\n`);
      process.exit(1);
    }
    process.stdout.write(`✓ Removed hive '${name}'\n`);
  });

// ---------------------------------------------------------------------------
// invites — manage outstanding invites on a server
// ---------------------------------------------------------------------------

const invitesCmd = program.command('invites').description('Manage outstanding invites on a server');

invitesCmd
  .command('list')
  .description('List outstanding invites')
  .option('-s, --server <url>', 'Server URL', 'http://localhost:7777')
  .option('--token <token>', 'Auth token (falls back to CHM_AUTH_TOKEN)')
  .action(async (opts: { server: string; token?: string }) => {
    const token = opts.token ?? process.env.CHM_AUTH_TOKEN;
    if (!token) {
      process.stderr.write('No auth token. Pass --token or set CHM_AUTH_TOKEN.\n');
      process.exit(1);
    }
    const res = await fetch(`${opts.server}/api/invites`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      process.stderr.write(`Failed: ${String(res.status)}\n`);
      process.exit(1);
    }
    const list = (await res.json()) as {
      code: string;
      label: string | null;
      consumed: boolean;
      expiresAt: string;
    }[];
    if (list.length === 0) {
      process.stdout.write('No invites.\n');
      return;
    }
    for (const i of list) {
      const status = i.consumed ? 'consumed' : 'pending ';
      process.stdout.write(`  ${i.code}  ${status}  expires ${i.expiresAt}  ${i.label ?? ''}\n`);
    }
  });

invitesCmd
  .command('revoke <code>')
  .description('Revoke an outstanding invite')
  .option('-s, --server <url>', 'Server URL', 'http://localhost:7777')
  .option('--token <token>', 'Auth token (falls back to CHM_AUTH_TOKEN)')
  .action(async (code: string, opts: { server: string; token?: string }) => {
    const token = opts.token ?? process.env.CHM_AUTH_TOKEN;
    if (!token) {
      process.stderr.write('No auth token. Pass --token or set CHM_AUTH_TOKEN.\n');
      process.exit(1);
    }
    const res = await fetch(`${opts.server}/api/invites/${code}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      process.stderr.write(`Failed: ${String(res.status)}\n`);
      process.exit(1);
    }
    process.stdout.write(`✓ Revoked ${code}\n`);
  });

// ---------------------------------------------------------------------------
// connect — MCP stdio bridge (legacy direct-connect mode)
// ---------------------------------------------------------------------------

program
  .command('connect')
  .description('Run as an MCP stdio bridge (deferred-connect; tools opt in via hive_connect)')
  .option('-s, --server <url>', 'Direct connect: server URL (skips deferred mode)')
  .option('-n, --name <name>', 'Display name for this agent (defaults to device hostname)', defaultDisplayName())
  .option('-t, --tool <tool>', 'Tool type (claude-code, cursor, codex, etc.)', 'claude-code')
  .option('--token <token>', 'Direct connect: auth token')
  .option('--workspace <path>', 'Workspace path', process.cwd())
  .action(
    async (opts: {
      server?: string;
      name: string;
      tool: string;
      token?: string;
      workspace: string;
    }) => {
      await startStdioServer({
        ...(opts.server !== undefined ? { serverUrl: opts.server } : {}),
        displayName: opts.name,
        tool: opts.tool,
        workspacePath: opts.workspace,
        ...(opts.token !== undefined ? { authToken: opts.token } : {}),
      });
    },
  );

program.parse();
