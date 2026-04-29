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

import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { Command } from 'commander';
import { loadConfig, validateConfig } from './config.js';
import { createHiveMindServer } from './server/server.js';
import { startStdioServer } from './mcp/stdio-server.js';
import { startQuickTunnel, type TunnelHandle } from './util/cloudflared.js';
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
// start — one-shot: serve + tunnel + invite, ready for teammates
// ---------------------------------------------------------------------------

program
  .command('start')
  .description(
    'One-shot launcher: starts the server, opens a public cloudflared tunnel, ' +
      'mints an invite, and prints a single URL you can share with teammates.',
  )
  .option('-p, --port <port>', 'Port to listen on', '7777')
  .option('--no-public', 'LAN-only mode (skip the public cloudflared tunnel)')
  .option('-l, --label <label>', 'Optional label for the invite (e.g. "demo run")')
  .option('--ttl <minutes>', 'How long the invite stays valid', '60')
  .action(
    async (opts: {
      port: string;
      public: boolean;
      label?: string;
      ttl: string;
    }) => {
      // Auto-generate an ephemeral admin token if the user didn't set one.
      // This is what makes `chm start` truly one-shot — no env var dance.
      if (!process.env.CHM_AUTH_TOKEN) {
        process.env.CHM_AUTH_TOKEN = randomBytes(32).toString('hex');
      }
      process.env.CHM_PORT = opts.port;
      process.env.CHM_HOST = '0.0.0.0';

      let tunnel: TunnelHandle | null = null;
      if (opts.public) {
        try {
          tunnel = await startQuickTunnel(parseInt(opts.port, 10), {
            onProgress: (msg) => {
              process.stdout.write(`  ${msg}\n`);
            },
          });
          process.env.CHM_PUBLIC_URL = tunnel.url;
        } catch (err) {
          process.stderr.write(
            `  Tunnel failed (${err instanceof Error ? err.message : String(err)}); ` +
              `continuing in LAN-only mode.\n`,
          );
        }
      }

      const config = loadConfig();
      setLogLevel(config.logLevel);
      for (const warning of validateConfig(config)) {
        logger.warn('config', warning);
      }

      const server = createHiveMindServer(config);
      await server.start();

      // Mint a fresh invite via the local HTTP API. Single-use; if a teammate
      // joins and another wants to follow, the host runs `chm invite` again.
      const ttlMs = Math.max(1, parseInt(opts.ttl, 10)) * 60 * 1000;
      let inviteUrl: string | null = null;
      try {
        const res = await fetch(`http://localhost:${opts.port}/api/invites`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.authToken}`,
          },
          body: JSON.stringify({
            ttlMs,
            ...(opts.label !== undefined ? { label: opts.label } : {}),
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { url?: string; code: string };
          inviteUrl =
            data.url ??
            formatInviteUrl(tunnel?.url ?? `http://localhost:${opts.port}`, data.code);
        }
      } catch (err) {
        logger.warn('cli', 'Failed to auto-mint invite', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      let shuttingDown = false;
      const shutdown = async (): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        if (tunnel) tunnel.stop();
        await server.stop();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());

      const dashboardUrl = tunnel?.url ?? `http://localhost:${opts.port}`;
      const ttlMin = Math.round(ttlMs / 60_000);
      const shareLine = inviteUrl ?? '(invite mint failed — run `chm invite` manually)';
      const accessHint = tunnel ? 'public · over the internet' : 'LAN only';
      const ttlHint = `single-use · ${String(ttlMin)} min`;

      process.stdout.write(`
╭──────────────────────────────────────────────────────────────────╮
│  Claude Hive Mind                                                │
│                                                                  │
│  Dashboard (you):                                                │
│    ${dashboardUrl.padEnd(62)}│
│    ${accessHint.padEnd(62)}│
│                                                                  │
│  Share this with a teammate (their AI calls hive_join with it):  │
│    ${shareLine.padEnd(62)}│
│    ${ttlHint.padEnd(62)}│
│                                                                  │
│  Need another invite?  chm invite                                │
│  Stop the hive:        Ctrl+C                                    │
╰──────────────────────────────────────────────────────────────────╯
`);
    },
  );

// ---------------------------------------------------------------------------
// serve — start the central server (advanced: explicit, no tunnel by default)
// ---------------------------------------------------------------------------

program
  .command('serve')
  .description('Start the central coordination server')
  .option('-p, --port <port>', 'Port to listen on', '7777')
  .option('-h, --host <host>', 'Host to bind to', '0.0.0.0')
  .option('--db <path>', 'SQLite database path', 'hive-mind.db')
  .option('--no-auth', 'Disable authentication')
  .option(
    '--public',
    'Expose this hive on the public internet via a cloudflared quick tunnel ' +
      '(no signup, no port forwarding). Invites will use the public URL so ' +
      'peers off your LAN can join.',
  )
  .action(
    async (opts: {
      port: string;
      host: string;
      db: string;
      auth: boolean;
      public?: boolean;
    }) => {
      if (opts.port) process.env.CHM_PORT = opts.port;
      if (opts.host) process.env.CHM_HOST = opts.host;
      if (opts.db) process.env.CHM_DB_PATH = opts.db;
      if (!opts.auth) process.env.CHM_AUTH_ENABLED = 'false';

      // Spin up cloudflared FIRST, then load config, so CHM_PUBLIC_URL is
      // visible when the invite endpoint constructs URLs.
      let tunnel: TunnelHandle | null = null;
      if (opts.public === true) {
        const port = parseInt(opts.port, 10);
        try {
          tunnel = await startQuickTunnel(port, {
            onProgress: (msg) => {
              process.stdout.write(`  ${msg}\n`);
            },
          });
          process.env.CHM_PUBLIC_URL = tunnel.url;
        } catch (err) {
          process.stderr.write(
            `Failed to start cloudflared tunnel: ${err instanceof Error ? err.message : String(err)}\n` +
              `Falling back to LAN-only mode.\n`,
          );
        }
      }

      const config = loadConfig();
      setLogLevel(config.logLevel);

      for (const warning of validateConfig(config)) {
        logger.warn('config', warning);
      }

      const server = createHiveMindServer(config);

      let shuttingDown = false;
      const shutdown = async (): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info('cli', 'Shutting down');
        if (tunnel) tunnel.stop();
        await server.stop();
        process.exit(0);
      };

      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());

      await server.start();

      // Loud warning if open reads + public tunnel are both on — anyone on
      // the internet can read every inter-agent DM. The combo is sometimes
      // intentional (public demo) but worth surfacing every startup.
      if (tunnel !== null && config.readAccess === 'open') {
        process.stderr.write(
          '\n⚠  SECURITY: readAccess=open + public tunnel = all messages and\n' +
            '  state are world-readable at the public URL. Set CHM_READ_ACCESS=required\n' +
            '  to require a token for reads, or run without --public for LAN-only mode.\n',
        );
      }

      const localUrl = `http://${config.host}:${String(config.port)}`;
      const publicLine =
        tunnel !== null
          ? `│  Public   : ${tunnel.url.padEnd(40)}│\n`
          : '';

      process.stdout.write(`
╭──────────────────────────────────────────────────────────╮
│  Claude Hive Mind is running                             │
│                                                          │
│  Server   : ${localUrl.padEnd(40)}                       │
│  Dashboard: ${localUrl.padEnd(40)}                       │
│  ${publicLine}                                           │
│  Invite a teammate:                                      │
│    chm invite                                            │
╰──────────────────────────────────────────────────────────╯
`);
    },
  );

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
    const data = (await res.json()) as {
      code: string;
      expiresAt: string;
      url?: string;
    };
    // Prefer the server-built URL — it embeds the public tunnel URL when
    // `chm serve --public` is on, so peers off the LAN can actually reach it.
    const url = data.url ?? formatInviteUrl(opts.server, data.code);
    const ttlMin = Math.round(ttlMs / 60_000);

    process.stdout.write(`
┌─────────────────────────────────────────────────────────┐
│  Invite created${opts.label ? ` for ${opts.label}` : ''}│
│                                                         │
│  Code:  ${data.code.padEnd(48)}                         │
│  URL:   ${url.padEnd(48)}                               │
│                                                         │
│  Share with your teammate. They run:                    │
│    claude-hive-mind join ${url.padEnd(28)}              │
│                                                         │
│  Expires in ${String(ttlMin).padEnd(2)} min. Single use.│
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
            'Or pass the full URL like chm://192.0.2.10:7777#A4F2-9E7K\n',
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
