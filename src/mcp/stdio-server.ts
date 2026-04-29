/**
 * MCP stdio server — bridge between an AI assistant and the Hive Mind.
 *
 * Two modes of operation:
 *
 *   1. **Deferred** (default, recommended): the bridge starts with only the
 *      always-on tools (hive_list_saved, hive_connect, hive_disconnect,
 *      hive_session_status). The model decides if THIS session joins a hive
 *      by calling hive_connect. After connect, the full hive_* toolset
 *      becomes available. Other Claude sessions on the same machine are
 *      independent.
 *
 *   2. **Direct** (legacy): pass --server <url> --token <X> to connect
 *      immediately on startup. Useful for headless / scripted setups.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { HiveMindClient } from './client.js';
import { ALWAYS_ON_TOOLS, TOOL_DEFINITIONS } from './tools.js';
import { zodToJsonSchema } from '../util/zod-to-json-schema.js';
import { logger } from '../util/logger.js';
import { addHive, getHive, listHives, parseInviteUrl, recordHiveUse } from '../util/credentials.js';

export interface StdioServerConfig {
  /** Direct-connect URL. Omit for deferred mode. */
  readonly serverUrl?: string;
  readonly displayName: string;
  readonly tool: string;
  readonly workspacePath: string;
  readonly authToken?: string | undefined;
}

interface SessionState {
  client: HiveMindClient | null;
  hiveName: string | null;
}

export async function startStdioServer(config: StdioServerConfig): Promise<void> {
  const session: SessionState = { client: null, hiveName: null };

  // Direct-connect mode: connect synchronously before listing tools.
  if (config.serverUrl) {
    const client = new HiveMindClient({
      serverUrl: config.serverUrl,
      displayName: config.displayName,
      tool: config.tool,
      workspacePath: config.workspacePath,
      heartbeatIntervalMs: 10_000,
      ...(config.authToken !== undefined ? { authToken: config.authToken } : {}),
    });
    const myAgentId = await client.connect();
    logger.info('mcp', 'Direct-connected to hive', {
      url: config.serverUrl,
      agentId: myAgentId,
    });
    session.client = client;
    session.hiveName = config.serverUrl;
  }

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const server = new Server(
    { name: 'claude-hive-mind', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => {
    // Always expose the lifecycle tools. The full hive_* toolset only when
    // a session is currently connected.
    const tools = [...ALWAYS_ON_TOOLS];
    if (session.client) {
      tools.push(...TOOL_DEFINITIONS);
    }
    return Promise.resolve({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: zodToJsonSchema(t.inputSchema),
      })),
    });
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await dispatchTool(session, config, name, args ?? {});
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  // Clean shutdown — disconnect the active hive client if any. Fires on
  // any of: SIGINT/SIGTERM/SIGHUP, parent closing stdin (Claude Code exit),
  // or the Node process otherwise being asked to exit. Idempotent so the
  // various paths can race without doubling the DELETE call.
  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    const disconnectPromise = session.client?.disconnect() ?? Promise.resolve();
    // Cap the disconnect at 1.5s so a stalled server never blocks shutdown.
    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(resolve, 1500).unref();
    });

    void Promise.race([disconnectPromise, timeoutPromise])
      .then(() => {
        process.exit(0);
      })
      .catch((err: unknown) => {
        logger.warn('mcp', 'Disconnect failed during shutdown', {
          reason,
          error: err instanceof Error ? err.message : String(err),
        });
        process.exit(1);
      });
  };
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGHUP', () => {
    shutdown('SIGHUP');
  });
  // When the MCP host (Claude Code, Cursor, etc.) closes the stdio pipe
  // — e.g. the user quits Claude or the terminal — Node sees stdin end.
  // Trigger a clean disconnect so the dashboard removes the bubble live.
  process.stdin.on('end', () => {
    shutdown('stdin-end');
  });
  process.stdin.on('close', () => {
    shutdown('stdin-close');
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

async function dispatchTool(
  session: SessionState,
  config: StdioServerConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // Always-on tools — handled regardless of connection state.
  switch (toolName) {
    case 'hive_list_saved':
      return handleListSaved();
    case 'hive_connect':
      return handleConnect(session, config, args);
    case 'hive_join':
      return handleJoin(session, config, args);
    case 'hive_disconnect':
      return handleDisconnect(session);
    case 'hive_session_status':
      return handleSessionStatus(session);
  }

  // All other tools require a connected session.
  if (!session.client) {
    throw new Error(
      `Not connected to any hive. Call hive_list_saved to see saved hives, then hive_connect("<name>") to join.`,
    );
  }

  // Validate args against the declared Zod schema before any cast.
  const tool = TOOL_DEFINITIONS.find((t) => t.name === toolName);
  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid arguments for ${toolName}: ${details}`);
  }
  const data = parsed.data as Record<string, unknown>;
  const client = session.client;

  switch (toolName) {
    case 'hive_status':
      return client.getStatus();
    case 'hive_claim_file':
      return client.claimFile(
        data.filePath as string,
        data.mode as string,
        data.taskId as string | undefined,
        data.branch as string | undefined,
      );
    case 'hive_release_file':
      return client.releaseFile(data.filePath as string);
    case 'hive_check_file':
      return client.checkFile(data.filePath as string);
    case 'hive_create_task': {
      const input: {
        title: string;
        description: string;
        priority?: string;
        filePaths?: string[];
        dependsOn?: string[];
      } = {
        title: data.title as string,
        description: data.description as string,
      };
      if (data.priority !== undefined) input.priority = data.priority as string;
      if (data.filePaths !== undefined) input.filePaths = data.filePaths as string[];
      if (data.dependsOn !== undefined) input.dependsOn = data.dependsOn as string[];
      return client.createTask(input);
    }
    case 'hive_assign_task':
      return client.assignTask(data.taskId as string);
    case 'hive_complete_task':
      return client.completeTask(data.taskId as string);
    case 'hive_fail_task':
      return client.failTask(data.taskId as string);
    case 'hive_share_knowledge': {
      const kInput: {
        key: string;
        value: string;
        sourceHash?: string;
        ttlSeconds?: number;
      } = {
        key: data.key as string,
        value: data.value as string,
      };
      if (data.sourceHash !== undefined) kInput.sourceHash = data.sourceHash as string;
      if (data.ttlSeconds !== undefined) kInput.ttlSeconds = data.ttlSeconds as number;
      return client.shareKnowledge(kInput);
    }
    case 'hive_get_knowledge':
      return client.getKnowledge(data.key as string);
    case 'hive_log_decision':
      return client.logDecision({
        category: data.category as string,
        summary: data.summary as string,
        rationale: data.rationale as string,
      });
    case 'hive_get_conflicts':
      return client.getConflicts();
    case 'hive_resolve_conflict':
      return client.resolveConflict(data.conflictId as string);
    case 'hive_update_branch':
      return client.updateBranch(data.branch as string);
    case 'hive_send_message':
      return client.sendMessage(data.toAgentId as string | null, data.content as string);
    case 'hive_get_messages': {
      const input: { since?: string; limit?: number } = {};
      if (data.since !== undefined) input.since = data.since as string;
      if (data.limit !== undefined) input.limit = data.limit as number;
      return client.getMessages(input);
    }
    case 'hive_share_git_status':
      return client.shareGitStatus({
        branch: data.branch as string | null,
        head: data.head as string | null,
        dirtyFiles: data.dirtyFiles as number,
        aheadOfRemote: data.aheadOfRemote as number,
        behindRemote: data.behindRemote as number,
      });
    case 'hive_share_run_result':
      return client.shareRunResult({
        command: data.command as string,
        success: data.success as boolean,
        summary: data.summary as string,
        durationMs: data.durationMs as number,
      });
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ---------------------------------------------------------------------------
// Always-on tool implementations
// ---------------------------------------------------------------------------

async function handleListSaved(): Promise<unknown> {
  const hives = await listHives();
  return {
    hives: hives.map(({ name, entry }) => ({
      name,
      url: entry.url,
      label: entry.label,
      addedAt: entry.addedAt,
      lastUsedAt: entry.lastUsedAt,
    })),
  };
}

async function handleConnect(
  session: SessionState,
  config: StdioServerConfig,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (session.client) {
    throw new Error(
      `Already connected to '${session.hiveName ?? 'unknown'}'. Call hive_disconnect first to switch hives.`,
    );
  }

  const name = typeof args.name === 'string' ? args.name : '';
  if (!name) {
    throw new Error('hive_connect requires a "name" argument (use hive_list_saved to see options)');
  }

  const hive = await getHive(name);
  if (!hive) {
    throw new Error(
      `No hive named '${name}' is saved. Run \`claude-hive-mind join <invite-url>\` to add one.`,
    );
  }

  const displayName =
    typeof args.displayName === 'string' && args.displayName.length > 0
      ? args.displayName
      : config.displayName;

  const client = new HiveMindClient({
    serverUrl: hive.url,
    displayName,
    tool: config.tool,
    workspacePath: config.workspacePath,
    heartbeatIntervalMs: 10_000,
    authToken: hive.joinToken,
  });

  const agentId = await client.connect();
  await recordHiveUse(name);

  session.client = client;
  session.hiveName = name;

  logger.info('mcp', 'Session joined hive', {
    hive: name,
    url: hive.url,
    agentId,
    displayName,
  });

  return {
    connected: true,
    hive: name,
    url: hive.url,
    agentId,
    displayName,
    message: `Connected to '${name}' as '${displayName}'. Hive tools are now available in this session.`,
  };
}

/**
 * Reject hive URLs that point at loopback, link-local, or RFC-1918 ranges
 * — those are likely SSRF attempts (cloud metadata at 169.254.169.254,
 * Docker bridges, internal services). The opt-out exists so genuine LAN
 * use (chm://192.168.x.x:7777) keeps working when the operator wants it.
 */
function assertSafeHiveTarget(serverUrl: string): void {
  if (process.env.CHM_ALLOW_PRIVATE_HIVES === '1') return;
  let host: string;
  let protocol: string;
  try {
    const u = new URL(serverUrl);
    host = u.hostname;
    protocol = u.protocol;
  } catch {
    throw new Error(`hive_join: malformed server URL: ${serverUrl}`);
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`hive_join: unsupported scheme '${protocol}' (only http/https allowed)`);
  }
  // Loopback, link-local, RFC-1918, IPv6 ULA / link-local. If the operator
  // really wants a LAN hive, they set CHM_ALLOW_PRIVATE_HIVES=1.
  const blocked =
    /^(127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|::1$|fc[0-9a-f]{2}:|fe80:|localhost$)/i;
  if (blocked.test(host)) {
    throw new Error(
      `hive_join: refusing to redeem against private/loopback host '${host}'. ` +
        `Set CHM_ALLOW_PRIVATE_HIVES=1 if this is intentional (e.g. LAN deployment).`,
    );
  }
}

async function handleJoin(
  session: SessionState,
  config: StdioServerConfig,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (session.client) {
    throw new Error(
      `Already connected to '${session.hiveName ?? 'unknown'}'. Call hive_disconnect first to switch hives.`,
    );
  }

  const invite = typeof args.invite === 'string' ? args.invite.trim() : '';
  if (!invite) {
    throw new Error('hive_join requires an "invite" argument (URL or bare code)');
  }

  let serverUrl: string;
  let code: string;
  const parsed = parseInviteUrl(invite);
  if (parsed) {
    serverUrl = parsed.url;
    code = parsed.code;
  } else {
    const fallback = typeof args.server === 'string' ? args.server : '';
    if (!fallback) {
      throw new Error(
        'Bare invite code requires a "server" argument (e.g. http://192.0.2.10:7777). ' +
          'Or pass the full chm:// URL instead.',
      );
    }
    serverUrl = fallback;
    code = invite;
  }

  // SSRF guard: a malicious invite could point hive_join at internal services
  // (cloud metadata endpoints, intranet hosts). Restrict to public-looking
  // destinations unless explicitly opted out via CHM_ALLOW_PRIVATE_HIVES=1.
  assertSafeHiveTarget(serverUrl);

  // Redeem the invite — this is anonymous on the server side.
  const res = await fetch(`${serverUrl}/api/invites/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Invite redemption failed (${String(res.status)}): ${text}`);
  }
  const data = (await res.json()) as {
    joinToken: string;
    joinTokenId: string;
    label: string | null;
  };

  const requestedName = typeof args.name === 'string' ? args.name : '';
  const hiveName =
    requestedName !== '' ? requestedName : (new URL(serverUrl).hostname.split('.')[0] ?? 'hive');

  await addHive({
    name: hiveName,
    url: serverUrl,
    joinToken: data.joinToken,
    joinTokenId: data.joinTokenId,
    ...(data.label !== null ? { label: data.label } : {}),
  });

  // Now register this session as an agent and start heartbeating.
  const displayName =
    typeof args.displayName === 'string' && args.displayName.length > 0
      ? args.displayName
      : config.displayName;
  const client = new HiveMindClient({
    serverUrl,
    displayName,
    tool: config.tool,
    workspacePath: config.workspacePath,
    heartbeatIntervalMs: 10_000,
    authToken: data.joinToken,
  });
  const agentId = await client.connect();
  await recordHiveUse(hiveName);

  session.client = client;
  session.hiveName = hiveName;

  logger.info('mcp', 'Session joined hive via invite', {
    hive: hiveName,
    url: serverUrl,
    agentId,
    displayName,
  });

  return {
    connected: true,
    hive: hiveName,
    url: serverUrl,
    agentId,
    displayName,
    message: `Joined '${hiveName}' as '${displayName}'. Hive tools are now available — and the bubble should already be visible on the dashboard.`,
  };
}

async function handleDisconnect(session: SessionState): Promise<unknown> {
  if (!session.client) {
    return { connected: false, message: 'Not connected to any hive.' };
  }
  const previousHive = session.hiveName;
  await session.client.disconnect();
  session.client = null;
  session.hiveName = null;
  logger.info('mcp', 'Session disconnected from hive', { hive: previousHive });
  return {
    connected: false,
    hive: previousHive,
    message: `Disconnected from '${previousHive ?? 'unknown'}'. Hive tools are no longer available in this session.`,
  };
}

function handleSessionStatus(session: SessionState): unknown {
  if (!session.client) {
    return {
      connected: false,
      message: 'Not connected to any hive in this session.',
    };
  }
  return {
    connected: true,
    hive: session.hiveName,
    agentId: session.client.agentId,
  };
}
