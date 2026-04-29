/**
 * MCP stdio server — bridge between an AI assistant and the Hive Mind.
 *
 * When Claude Code (or any MCP-compatible tool) starts this process,
 * it registers with the central server, exposes hive tools, and
 * forwards tool calls as HTTP API requests.
 *
 * Usage:
 *   claude-hive-mind connect --server http://localhost:7777 --name "My Agent"
 *
 * This runs as a subprocess managed by the AI tool. It communicates
 * with the AI tool over stdio (JSON-RPC) and with the central server
 * over HTTP.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { HiveMindClient } from './client.js';
import { TOOL_DEFINITIONS } from './tools.js';
import { zodToJsonSchema } from '../util/zod-to-json-schema.js';
import { logger } from '../util/logger.js';

export interface StdioServerConfig {
  readonly serverUrl: string;
  readonly displayName: string;
  readonly tool: string;
  readonly workspacePath: string;
  readonly authToken?: string | undefined;
}

export async function startStdioServer(config: StdioServerConfig): Promise<void> {
  const clientConfig = {
    serverUrl: config.serverUrl,
    displayName: config.displayName,
    tool: config.tool,
    workspacePath: config.workspacePath,
    heartbeatIntervalMs: 10_000,
    ...(config.authToken !== undefined ? { authToken: config.authToken } : {}),
  };

  const client = new HiveMindClient(clientConfig);

  // Register with the central server
  const myAgentId = await client.connect();
  logger.info('mcp', 'Connected to hive', {
    displayName: config.displayName,
    agentId: myAgentId,
  });

  // Create MCP server
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const server = new Server(
    { name: 'claude-hive-mind', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // Register tool listing
  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: TOOL_DEFINITIONS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: zodToJsonSchema(t.inputSchema),
      })),
    }),
  );

  // Register tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await executeToolCall(client, name, args ?? {});
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

  // Handle clean shutdown — always exit, even when disconnect rejects.
  const shutdown = (signal: string): void => {
    void client
      .disconnect()
      .then(() => {
        process.exit(0);
      })
      .catch((err: unknown) => {
        logger.warn('mcp', 'Disconnect failed during shutdown', {
          signal,
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

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

/** Look up a registered tool by name. */
function findTool(toolName: string): (typeof TOOL_DEFINITIONS)[number] {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === toolName);
  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  return tool;
}

async function executeToolCall(
  client: HiveMindClient,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // Validate args against the declared Zod schema before any cast.
  const tool = findTool(toolName);
  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid arguments for ${toolName}: ${details}`);
  }
  const data = parsed.data as Record<string, unknown>;

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

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
