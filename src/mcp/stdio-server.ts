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
  console.error(`[HiveMind MCP] Connected as ${config.displayName} (${myAgentId})`);

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

  // Handle clean shutdown
  process.on('SIGINT', () => {
    void client.disconnect().then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void client.disconnect().then(() => process.exit(0));
  });

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

async function executeToolCall(
  client: HiveMindClient,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (toolName) {
    case 'hive_status':
      return client.getStatus();

    case 'hive_claim_file':
      return client.claimFile(
        args.filePath as string,
        args.mode as string,
        args.taskId as string | undefined,
        args.branch as string | undefined,
      );

    case 'hive_release_file':
      return client.releaseFile(args.filePath as string);

    case 'hive_check_file':
      return client.checkFile(args.filePath as string);

    case 'hive_create_task': {
      const input: {
        title: string;
        description: string;
        priority?: string;
        filePaths?: string[];
        dependsOn?: string[];
      } = {
        title: args.title as string,
        description: args.description as string,
      };
      if (args.priority !== undefined) input.priority = args.priority as string;
      if (args.filePaths !== undefined) input.filePaths = args.filePaths as string[];
      if (args.dependsOn !== undefined) input.dependsOn = args.dependsOn as string[];
      return client.createTask(input);
    }

    case 'hive_assign_task':
      return client.assignTask(args.taskId as string);

    case 'hive_complete_task':
      return client.completeTask(args.taskId as string);

    case 'hive_fail_task':
      return client.failTask(args.taskId as string);

    case 'hive_share_knowledge': {
      const kInput: {
        key: string;
        value: string;
        sourceHash?: string;
        ttlSeconds?: number;
      } = {
        key: args.key as string,
        value: args.value as string,
      };
      if (args.sourceHash !== undefined) kInput.sourceHash = args.sourceHash as string;
      if (args.ttlSeconds !== undefined) kInput.ttlSeconds = args.ttlSeconds as number;
      return client.shareKnowledge(kInput);
    }

    case 'hive_get_knowledge':
      return client.getKnowledge(args.key as string);

    case 'hive_log_decision':
      return client.logDecision({
        category: args.category as string,
        summary: args.summary as string,
        rationale: args.rationale as string,
      });

    case 'hive_get_conflicts':
      return client.getConflicts();

    case 'hive_resolve_conflict':
      return client.resolveConflict(args.conflictId as string);

    case 'hive_update_branch':
      return client.updateBranch(args.branch as string);

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
