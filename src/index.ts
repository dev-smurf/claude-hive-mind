/**
 * Claude Hive Mind — public API exports.
 *
 * Use these to programmatically create a server or connect as a client.
 */

export { createHiveMindServer } from './server/server.js';
export type { HiveMindServer } from './server/server.js';
export { HiveMindClient } from './mcp/client.js';
export type { ClientConfig } from './mcp/client.js';
export { loadConfig, validateConfig } from './config.js';
export type { Config } from './config.js';

// Re-export core types
export type {
  AgentId,
  TaskId,
  ConflictId,
  DecisionId,
  ISOTimestamp,
  AgentRecord,
  AgentStatus,
  AgentTool,
  FileOwnership,
  OwnershipMode,
  Task,
  TaskStatus,
  TaskPriority,
  KnowledgeEntry,
  Decision,
  DecisionCategory,
  Conflict,
  ConflictType,
  ConflictSeverity,
  HiveMindState,
  HiveMindStatus,
  ServerMessage,
  ClientMessage,
} from './types.js';

export const VERSION = '0.1.0';
