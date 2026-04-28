#!/usr/bin/env node
/**
 * CLI entry point for Claude Hive Mind.
 *
 * Commands:
 *   serve   — Start the central coordination server
 *   connect — Start an MCP stdio bridge to the central server
 */

import { Command } from 'commander';
import { loadConfig } from './config.js';
import { createHiveMindServer } from './server/server.js';
import { startStdioServer } from './mcp/stdio-server.js';

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
    // Override config from CLI flags
    if (opts.port) process.env.CHM_PORT = opts.port;
    if (opts.host) process.env.CHM_HOST = opts.host;
    if (opts.db) process.env.CHM_DB_PATH = opts.db;
    if (!opts.auth) process.env.CHM_AUTH_ENABLED = 'false';

    const config = loadConfig();
    const server = createHiveMindServer(config);

    // Graceful shutdown
    const shutdown = async (): Promise<void> => {
      console.log('\n[HiveMind] Shutting down...');
      await server.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());

    await server.start();
  });

// ---------------------------------------------------------------------------
// connect — start MCP stdio bridge
// ---------------------------------------------------------------------------

program
  .command('connect')
  .description('Connect to a central server as an MCP tool provider')
  .requiredOption('-s, --server <url>', 'Central server URL (e.g. http://localhost:7777)')
  .option('-n, --name <name>', 'Display name for this agent', 'Claude Code Agent')
  .option('-t, --tool <tool>', 'Tool type (claude-code, cursor, codex, etc.)', 'claude-code')
  .option('--token <token>', 'Auth token for the server')
  .option('--workspace <path>', 'Workspace path', process.cwd())
  .action(
    async (opts: {
      server: string;
      name: string;
      tool: string;
      token?: string;
      workspace: string;
    }) => {
      await startStdioServer({
        serverUrl: opts.server,
        displayName: opts.name,
        tool: opts.tool,
        workspacePath: opts.workspace,
        ...(opts.token !== undefined ? { authToken: opts.token } : {}),
      });
    },
  );

program.parse();
