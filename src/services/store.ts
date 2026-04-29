/**
 * SQLite persistence layer for Claude Hive Mind.
 *
 * Wraps better-sqlite3 with typed CRUD operations for every domain entity.
 * All queries use parameterized statements — zero string concatenation.
 *
 * Design:
 * - WAL mode for concurrent reads while writing
 * - Foreign keys enforced
 * - JSON columns for arrays (file_paths, depends_on)
 * - In-memory option for tests (path = ':memory:')
 * - Schema created on open, idempotent (IF NOT EXISTS)
 */

import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import type {
  AgentRecord,
  AgentId,
  AgentStatus,
  AgentTool,
  FileOwnership,
  OwnershipMode,
  Task,
  TaskId,
  TaskStatus,
  TaskPriority,
  KnowledgeEntry,
  Decision,
  DecisionId,
  DecisionCategory,
  Conflict,
  ConflictId,
  ConflictType,
  ConflictSeverity,
  ISOTimestamp,
} from '../types.js';
import {
  agentId,
  taskId,
  conflictId,
  decisionId,
  isoTimestamp,
  agentStatusSchema,
  agentToolSchema,
  ownershipModeSchema,
  taskStatusSchema,
  taskPrioritySchema,
  decisionCategorySchema,
  conflictTypeSchema,
  conflictSeveritySchema,
} from '../schemas.js';
import { logger } from '../util/logger.js';

// ---------------------------------------------------------------------------
// Row types — what SQLite actually returns (flat, no branded types)
// ---------------------------------------------------------------------------

interface AgentRow {
  id: string;
  display_name: string;
  tool: string;
  status: string;
  current_task_id: string | null;
  last_heartbeat: string;
  connected_at: string;
  workspace_path: string;
  current_branch: string | null;
  repo_url: string | null;
  agent_token: string;
}

interface FileOwnershipRow {
  file_path: string;
  agent_id: string;
  mode: string;
  task_id: string | null;
  claimed_at: string;
  expires_at: string | null;
  branch: string; // '' = unknown branch (sentinel for NULL in domain)
}

interface TaskRow {
  id: string;
  title: string;
  description: string;
  assigned_agent_id: string | null;
  status: string;
  priority: string;
  file_paths: string; // JSON array
  depends_on: string; // JSON array
  created_at: string;
  updated_at: string;
}

interface KnowledgeRow {
  key: string;
  value: string;
  agent_id: string;
  source_hash: string | null;
  created_at: string;
  ttl_seconds: number | null;
}

interface DecisionRow {
  id: string;
  agent_id: string;
  category: string;
  summary: string;
  rationale: string;
  timestamp: string;
}

interface ConflictRow {
  id: string;
  type: string;
  severity: string;
  agent_a: string;
  agent_b: string;
  file_paths: string; // JSON array
  description: string;
  resolved: number; // SQLite boolean: 0 or 1
  detected_at: string;
}

// ---------------------------------------------------------------------------
// Row → Domain converters
// ---------------------------------------------------------------------------

/**
 * Validate a string against a Zod enum schema. On failure, log the
 * drift and throw — the row converter sits at the storage→domain
 * boundary, so corruption here must surface immediately.
 */
function parseEnum<T extends string>(
  schema: { parse: (val: unknown) => T },
  value: string,
  field: string,
): T {
  try {
    return schema.parse(value);
  } catch {
    logger.error('store', `Invalid ${field} value in DB row`, { value, field });
    throw new Error(`Invalid ${field} value in DB: "${value}"`);
  }
}

/**
 * Safely parse a JSON column. On parse failure, logs the corruption and
 * substitutes a fallback so a single bad row cannot brick reads of the
 * whole table.
 */
function parseJsonArray(raw: string, table: string, rowId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Filter — array could legitimately parse but contain non-strings if a row
    // was corrupted by direct SQL or a future schema change.
    return parsed.filter((e): e is string => typeof e === 'string');
  } catch {
    logger.error('store', 'Corrupt JSON column — substituting empty array', {
      table,
      rowId,
      raw,
    });
    return [];
  }
}

function rowToAgent(row: AgentRow): AgentRecord {
  return {
    id: agentId(row.id),
    displayName: row.display_name,
    tool: parseEnum<AgentTool>(agentToolSchema, row.tool, 'agent.tool'),
    status: parseEnum<AgentStatus>(agentStatusSchema, row.status, 'agent.status'),
    currentTaskId: row.current_task_id ? taskId(row.current_task_id) : null,
    lastHeartbeat: row.last_heartbeat as ISOTimestamp,
    connectedAt: row.connected_at as ISOTimestamp,
    workspacePath: row.workspace_path,
    currentBranch: row.current_branch,
    repoUrl: row.repo_url,
  };
}

function rowToFileOwnership(row: FileOwnershipRow): FileOwnership {
  return {
    filePath: row.file_path,
    agentId: agentId(row.agent_id),
    mode: parseEnum<OwnershipMode>(ownershipModeSchema, row.mode, 'ownership.mode'),
    taskId: row.task_id ? taskId(row.task_id) : null,
    claimedAt: row.claimed_at as ISOTimestamp,
    expiresAt: row.expires_at as ISOTimestamp | null,
    branch: row.branch || null, // '' sentinel → null in domain
  };
}

function rowToTask(row: TaskRow): Task {
  return {
    id: taskId(row.id),
    title: row.title,
    description: row.description,
    assignedAgentId: row.assigned_agent_id ? agentId(row.assigned_agent_id) : null,
    status: parseEnum<TaskStatus>(taskStatusSchema, row.status, 'task.status'),
    priority: parseEnum<TaskPriority>(taskPrioritySchema, row.priority, 'task.priority'),
    filePaths: parseJsonArray(row.file_paths, 'tasks.file_paths', row.id),
    dependsOn: parseJsonArray(row.depends_on, 'tasks.depends_on', row.id).map(taskId),
    createdAt: row.created_at as ISOTimestamp,
    updatedAt: row.updated_at as ISOTimestamp,
  };
}

function rowToKnowledge(row: KnowledgeRow): KnowledgeEntry {
  return {
    key: row.key,
    value: row.value,
    agentId: agentId(row.agent_id),
    sourceHash: row.source_hash,
    createdAt: row.created_at as ISOTimestamp,
    ttlSeconds: row.ttl_seconds,
  };
}

function rowToDecision(row: DecisionRow): Decision {
  return {
    id: decisionId(row.id),
    agentId: agentId(row.agent_id),
    category: parseEnum<DecisionCategory>(
      decisionCategorySchema,
      row.category,
      'decision.category',
    ),
    summary: row.summary,
    rationale: row.rationale,
    timestamp: row.timestamp as ISOTimestamp,
  };
}

function rowToConflict(row: ConflictRow): Conflict {
  return {
    id: conflictId(row.id),
    type: parseEnum<ConflictType>(conflictTypeSchema, row.type, 'conflict.type'),
    severity: parseEnum<ConflictSeverity>(
      conflictSeveritySchema,
      row.severity,
      'conflict.severity',
    ),
    agentA: agentId(row.agent_a),
    agentB: agentId(row.agent_b),
    filePaths: parseJsonArray(row.file_paths, 'conflicts.file_paths', row.id),
    description: row.description,
    resolved: row.resolved === 1,
    detectedAt: row.detected_at as ISOTimestamp,
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS agents (
    id              TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL,
    tool            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',
    current_task_id TEXT,
    last_heartbeat  TEXT NOT NULL,
    connected_at    TEXT NOT NULL,
    workspace_path  TEXT NOT NULL,
    current_branch  TEXT,
    repo_url        TEXT,
    agent_token     TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS file_ownership (
    file_path   TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    mode        TEXT NOT NULL,
    task_id     TEXT,
    claimed_at  TEXT NOT NULL,
    expires_at  TEXT,
    branch      TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (file_path, branch, agent_id),
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id                TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    description       TEXT NOT NULL DEFAULT '',
    assigned_agent_id TEXT,
    status            TEXT NOT NULL DEFAULT 'pending',
    priority          TEXT NOT NULL DEFAULT 'medium',
    file_paths        TEXT NOT NULL DEFAULT '[]',
    depends_on        TEXT NOT NULL DEFAULT '[]',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    FOREIGN KEY (assigned_agent_id) REFERENCES agents(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS knowledge (
    key          TEXT PRIMARY KEY,
    value        TEXT NOT NULL,
    agent_id     TEXT NOT NULL,
    source_hash  TEXT,
    created_at   TEXT NOT NULL,
    ttl_seconds  INTEGER,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS decisions (
    id        TEXT PRIMARY KEY,
    agent_id  TEXT NOT NULL,
    category  TEXT NOT NULL,
    summary   TEXT NOT NULL,
    rationale TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS conflicts (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    severity    TEXT NOT NULL,
    agent_a     TEXT NOT NULL,
    agent_b     TEXT NOT NULL,
    file_paths  TEXT NOT NULL DEFAULT '[]',
    description TEXT NOT NULL,
    resolved    INTEGER NOT NULL DEFAULT 0,
    detected_at TEXT NOT NULL,
    FOREIGN KEY (agent_a) REFERENCES agents(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_b) REFERENCES agents(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS invites (
    code         TEXT PRIMARY KEY,
    created_by   TEXT NOT NULL,        -- 'admin' or agent_id
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    consumed_at  TEXT,
    consumed_by  TEXT,                 -- join_token id once redeemed
    consumed_ip  TEXT,
    label        TEXT
  );

  CREATE TABLE IF NOT EXISTS join_tokens (
    id            TEXT PRIMARY KEY,    -- short ID for revocation
    token_hash    TEXT NOT NULL UNIQUE,-- sha256 of the bearer token
    created_at    TEXT NOT NULL,
    invite_code   TEXT,                -- the invite that issued this
    label         TEXT,                -- "Felix's machine"
    last_used_at  TEXT,
    agent_count   INTEGER NOT NULL DEFAULT 0,
    revoked       INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    from_agent_id   TEXT NOT NULL,
    to_agent_id     TEXT,                  -- NULL = broadcast
    content         TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    FOREIGN KEY (from_agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    FOREIGN KEY (to_agent_id)   REFERENCES agents(id) ON DELETE CASCADE
  );

  -- Per-agent free-form status metadata (git status, last test run, etc.)
  -- Keyed by (agent_id, key) for flexibility without bloating the agents
  -- table. Values are JSON strings; readers decode as needed.
  CREATE TABLE IF NOT EXISTS agent_metadata (
    agent_id    TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (agent_id, key),
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
  CREATE INDEX IF NOT EXISTS idx_agents_token ON agents(agent_token);
  CREATE INDEX IF NOT EXISTS idx_file_ownership_agent ON file_ownership(agent_id);
  CREATE INDEX IF NOT EXISTS idx_file_ownership_branch ON file_ownership(branch);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_agent_id);
  CREATE INDEX IF NOT EXISTS idx_knowledge_agent ON knowledge(agent_id);
  CREATE INDEX IF NOT EXISTS idx_decisions_category ON decisions(category);
  CREATE INDEX IF NOT EXISTS idx_conflicts_resolved ON conflicts(resolved);
  CREATE INDEX IF NOT EXISTS idx_invites_expires ON invites(expires_at);
  CREATE INDEX IF NOT EXISTS idx_join_tokens_hash ON join_tokens(token_hash);
  CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent_id);
  CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_agent_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
`;

/**
 * Lightweight in-place migrations. Idempotent. Adds new columns to
 * existing databases that pre-date their introduction.
 */
function runMigrations(db: BetterSqlite3.Database): void {
  const cols = db.prepare('PRAGMA table_info(agents)').all() as { name: string }[];
  const colNames = new Set(cols.map((c) => c.name));

  // Wrap all schema changes in a single transaction so a torn migration
  // (process kill, disk full) cannot leave the schema partially applied.
  db.transaction(() => {
    if (!colNames.has('current_branch')) {
      db.exec('ALTER TABLE agents ADD COLUMN current_branch TEXT');
    }
    if (!colNames.has('repo_url')) {
      db.exec('ALTER TABLE agents ADD COLUMN repo_url TEXT');
    }
    if (!colNames.has('agent_token')) {
      db.exec("ALTER TABLE agents ADD COLUMN agent_token TEXT NOT NULL DEFAULT ''");
    }

    // Migrate file_ownership PK from (file_path, branch) to
    // (file_path, branch, agent_id) so multiple agents can each hold a
    // shared claim on the same file simultaneously.
    const indexes = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='file_ownership'")
      .all() as { sql: string }[];
    const existingSql = indexes[0]?.sql ?? '';
    const needsPkMigration =
      existingSql.includes('PRIMARY KEY (file_path, branch)') &&
      !existingSql.includes('PRIMARY KEY (file_path, branch, agent_id)');

    if (needsPkMigration) {
      db.exec(`
        CREATE TABLE file_ownership_new (
          file_path   TEXT NOT NULL,
          agent_id    TEXT NOT NULL,
          mode        TEXT NOT NULL,
          task_id     TEXT,
          claimed_at  TEXT NOT NULL,
          expires_at  TEXT,
          branch      TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (file_path, branch, agent_id),
          FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
        );
        INSERT INTO file_ownership_new
          SELECT file_path, agent_id, mode, task_id, claimed_at, expires_at, branch
          FROM file_ownership;
        DROP TABLE file_ownership;
        ALTER TABLE file_ownership_new RENAME TO file_ownership;
      `);
    }
  })();
}

// ---------------------------------------------------------------------------
// Store class
// ---------------------------------------------------------------------------

export class Store {
  private readonly db: BetterSqlite3.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
    runMigrations(this.db);
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------

  /**
   * Upsert an agent. Optionally writes/rotates the agent token. If
   * `agentToken` is omitted on update, the existing token is preserved.
   */
  upsertAgent(agent: AgentRecord, agentToken?: string): void {
    if (agentToken !== undefined) {
      this.db
        .prepare(
          `INSERT INTO agents (id, display_name, tool, status, current_task_id, last_heartbeat, connected_at, workspace_path, current_branch, repo_url, agent_token)
           VALUES (@id, @displayName, @tool, @status, @currentTaskId, @lastHeartbeat, @connectedAt, @workspacePath, @currentBranch, @repoUrl, @agentToken)
           ON CONFLICT(id) DO UPDATE SET
             display_name = @displayName,
             tool = @tool,
             status = @status,
             current_task_id = @currentTaskId,
             last_heartbeat = @lastHeartbeat,
             workspace_path = @workspacePath,
             current_branch = @currentBranch,
             repo_url = @repoUrl,
             agent_token = @agentToken`,
        )
        .run({
          id: agent.id,
          displayName: agent.displayName,
          tool: agent.tool,
          status: agent.status,
          currentTaskId: agent.currentTaskId,
          lastHeartbeat: agent.lastHeartbeat,
          connectedAt: agent.connectedAt,
          workspacePath: agent.workspacePath,
          currentBranch: agent.currentBranch,
          repoUrl: agent.repoUrl,
          agentToken,
        });
      return;
    }

    this.db
      .prepare(
        `INSERT INTO agents (id, display_name, tool, status, current_task_id, last_heartbeat, connected_at, workspace_path, current_branch, repo_url)
         VALUES (@id, @displayName, @tool, @status, @currentTaskId, @lastHeartbeat, @connectedAt, @workspacePath, @currentBranch, @repoUrl)
         ON CONFLICT(id) DO UPDATE SET
           display_name = @displayName,
           tool = @tool,
           status = @status,
           current_task_id = @currentTaskId,
           last_heartbeat = @lastHeartbeat,
           workspace_path = @workspacePath,
           current_branch = @currentBranch,
           repo_url = @repoUrl`,
      )
      .run({
        id: agent.id,
        displayName: agent.displayName,
        tool: agent.tool,
        status: agent.status,
        currentTaskId: agent.currentTaskId,
        lastHeartbeat: agent.lastHeartbeat,
        connectedAt: agent.connectedAt,
        workspacePath: agent.workspacePath,
        currentBranch: agent.currentBranch,
        repoUrl: agent.repoUrl,
      });
  }

  /**
   * Look up an agent by their auth token. Used by the auth middleware
   * to map an incoming Bearer token to an agent identity.
   *
   * Selects explicit columns (not `*`) so the agent_token column never
   * accidentally rides along into a serialized response.
   */
  getAgentByToken(token: string): AgentRecord | undefined {
    if (!token) return undefined;
    const row = this.db
      .prepare(
        `SELECT ${Store.AGENT_COLUMNS} FROM agents WHERE agent_token = ? AND agent_token != ''`,
      )
      .get(token) as AgentRow | undefined;
    return row ? rowToAgent(row) : undefined;
  }

  /**
   * Defense-in-depth: every agent SELECT lists explicit columns and projects
   * agent_token to '' so the secret never rides in the in-memory row.
   */
  private static readonly AGENT_COLUMNS = `id, display_name, tool, status, current_task_id, last_heartbeat,
       connected_at, workspace_path, current_branch, repo_url, '' as agent_token`;

  /** Get agents whose status is in the given set. Indexed query. */
  getAgentsByStatus(...statuses: readonly AgentStatus[]): readonly AgentRecord[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT ${Store.AGENT_COLUMNS} FROM agents WHERE status IN (${placeholders}) ORDER BY connected_at`,
      )
      .all(...statuses) as AgentRow[];
    return rows.map(rowToAgent);
  }

  getAgent(id: AgentId): AgentRecord | undefined {
    const row = this.db
      .prepare(`SELECT ${Store.AGENT_COLUMNS} FROM agents WHERE id = ?`)
      .get(id) as AgentRow | undefined;
    return row ? rowToAgent(row) : undefined;
  }

  getAllAgents(): readonly AgentRecord[] {
    const rows = this.db
      .prepare(`SELECT ${Store.AGENT_COLUMNS} FROM agents ORDER BY connected_at`)
      .all() as AgentRow[];
    return rows.map(rowToAgent);
  }

  updateAgentStatus(id: AgentId, status: AgentStatus): void {
    this.db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, id);
  }

  updateAgentHeartbeat(id: AgentId, timestamp: ISOTimestamp): void {
    this.db.prepare('UPDATE agents SET last_heartbeat = ? WHERE id = ?').run(timestamp, id);
  }

  updateAgentTask(id: AgentId, currentTaskId: TaskId | null): void {
    this.db.prepare('UPDATE agents SET current_task_id = ? WHERE id = ?').run(currentTaskId, id);
  }

  updateAgentBranch(id: AgentId, branch: string | null): void {
    this.db.prepare('UPDATE agents SET current_branch = ? WHERE id = ?').run(branch, id);
  }

  deleteAgent(id: AgentId): void {
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  }

  getStaleAgents(cutoff: ISOTimestamp): readonly AgentRecord[] {
    const rows = this.db
      .prepare(`SELECT ${Store.AGENT_COLUMNS} FROM agents WHERE last_heartbeat < ? AND status != ?`)
      .all(cutoff, 'disconnected') as AgentRow[];
    return rows.map(rowToAgent);
  }

  // -------------------------------------------------------------------------
  // File Ownership
  // -------------------------------------------------------------------------

  upsertFileOwnership(ownership: FileOwnership): void {
    this.db
      .prepare(
        `INSERT INTO file_ownership (file_path, agent_id, mode, task_id, claimed_at, expires_at, branch)
         VALUES (@filePath, @agentId, @mode, @taskId, @claimedAt, @expiresAt, @branch)
         ON CONFLICT(file_path, branch, agent_id) DO UPDATE SET
           mode = @mode,
           task_id = @taskId,
           claimed_at = @claimedAt,
           expires_at = @expiresAt`,
      )
      .run({
        filePath: ownership.filePath,
        agentId: ownership.agentId,
        mode: ownership.mode,
        taskId: ownership.taskId,
        claimedAt: ownership.claimedAt,
        expiresAt: ownership.expiresAt,
        branch: ownership.branch ?? '', // null → '' sentinel in DB
      });
  }

  /**
   * Returns the FIRST claim on (file_path, branch). With shared mode allowing
   * multiple claims, callers that need agent-scoped lookups should use
   * `getFileOwnershipByAgent` instead.
   */
  getFileOwnership(filePath: string, branch?: string | null): FileOwnership | undefined {
    const branchVal = branch ?? '';
    const row = this.db
      .prepare(
        'SELECT * FROM file_ownership WHERE file_path = ? AND branch = ? ORDER BY claimed_at LIMIT 1',
      )
      .get(filePath, branchVal) as FileOwnershipRow | undefined;
    return row ? rowToFileOwnership(row) : undefined;
  }

  /** Look up a specific agent's claim on a (file_path, branch). */
  getFileOwnershipByAgent(
    filePath: string,
    branch: string | null,
    agentIdVal: AgentId,
  ): FileOwnership | undefined {
    const branchVal = branch ?? '';
    const row = this.db
      .prepare('SELECT * FROM file_ownership WHERE file_path = ? AND branch = ? AND agent_id = ?')
      .get(filePath, branchVal, agentIdVal) as FileOwnershipRow | undefined;
    return row ? rowToFileOwnership(row) : undefined;
  }

  /** Get all claims for a file path across all branches. */
  getFileOwnershipsByPath(filePath: string): readonly FileOwnership[] {
    const rows = this.db
      .prepare('SELECT * FROM file_ownership WHERE file_path = ? ORDER BY claimed_at')
      .all(filePath) as FileOwnershipRow[];
    return rows.map(rowToFileOwnership);
  }

  getFilesByAgent(agentIdVal: AgentId): readonly FileOwnership[] {
    const rows = this.db
      .prepare('SELECT * FROM file_ownership WHERE agent_id = ? ORDER BY claimed_at')
      .all(agentIdVal) as FileOwnershipRow[];
    return rows.map(rowToFileOwnership);
  }

  getAllFileOwnerships(): readonly FileOwnership[] {
    const rows = this.db
      .prepare('SELECT * FROM file_ownership ORDER BY claimed_at')
      .all() as FileOwnershipRow[];
    return rows.map(rowToFileOwnership);
  }

  /**
   * Delete a specific agent's claim on (file_path, branch). The agent_id is
   * required so a release call cannot accidentally erase another agent's
   * shared claim on the same file.
   */
  deleteFileOwnership(filePath: string, branch: string | null, agentIdVal: AgentId): boolean {
    const branchVal = branch ?? '';
    const result = this.db
      .prepare('DELETE FROM file_ownership WHERE file_path = ? AND branch = ? AND agent_id = ?')
      .run(filePath, branchVal, agentIdVal);
    return result.changes > 0;
  }

  deleteFilesByAgent(agentIdVal: AgentId): void {
    this.db.prepare('DELETE FROM file_ownership WHERE agent_id = ?').run(agentIdVal);
  }

  getExpiredFiles(now: ISOTimestamp): readonly FileOwnership[] {
    const rows = this.db
      .prepare('SELECT * FROM file_ownership WHERE expires_at IS NOT NULL AND expires_at < ?')
      .all(now) as FileOwnershipRow[];
    return rows.map(rowToFileOwnership);
  }

  countFilesByAgent(agentIdVal: AgentId): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM file_ownership WHERE agent_id = ?')
      .get(agentIdVal) as { count: number };
    return row.count;
  }

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  insertTask(task: Task): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, description, assigned_agent_id, status, priority, file_paths, depends_on, created_at, updated_at)
         VALUES (@id, @title, @description, @assignedAgentId, @status, @priority, @filePaths, @dependsOn, @createdAt, @updatedAt)`,
      )
      .run({
        id: task.id,
        title: task.title,
        description: task.description,
        assignedAgentId: task.assignedAgentId,
        status: task.status,
        priority: task.priority,
        filePaths: JSON.stringify(task.filePaths),
        dependsOn: JSON.stringify(task.dependsOn),
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      });
  }

  getTask(id: TaskId): Task | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  getAllTasks(): readonly Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY created_at').all() as TaskRow[];
    return rows.map(rowToTask);
  }

  getTasksByStatus(status: TaskStatus): readonly Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at')
      .all(status) as TaskRow[];
    return rows.map(rowToTask);
  }

  /**
   * Get tasks assigned to a specific agent in a specific status. Indexed
   * query — used at agent disconnect time to find orphaned tasks.
   */
  getTasksAssignedTo(agentIdVal: AgentId, status: TaskStatus): readonly Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE assigned_agent_id = ? AND status = ? ORDER BY created_at')
      .all(agentIdVal, status) as TaskRow[];
    return rows.map(rowToTask);
  }

  updateTaskStatus(id: TaskId, status: TaskStatus, updatedAt: ISOTimestamp): void {
    this.db
      .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, updatedAt, id);
  }

  assignTask(id: TaskId, agentIdVal: AgentId, updatedAt: ISOTimestamp): void {
    this.db
      .prepare('UPDATE tasks SET assigned_agent_id = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(agentIdVal, 'in_progress', updatedAt, id);
  }

  unassignTask(id: TaskId, updatedAt: ISOTimestamp): void {
    this.db
      .prepare('UPDATE tasks SET assigned_agent_id = NULL, status = ?, updated_at = ? WHERE id = ?')
      .run('pending', updatedAt, id);
  }

  deleteTask(id: TaskId): void {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  // -------------------------------------------------------------------------
  // Knowledge
  // -------------------------------------------------------------------------

  upsertKnowledge(entry: KnowledgeEntry): void {
    this.db
      .prepare(
        `INSERT INTO knowledge (key, value, agent_id, source_hash, created_at, ttl_seconds)
         VALUES (@key, @value, @agentId, @sourceHash, @createdAt, @ttlSeconds)
         ON CONFLICT(key) DO UPDATE SET
           value = @value,
           agent_id = @agentId,
           source_hash = @sourceHash,
           created_at = @createdAt,
           ttl_seconds = @ttlSeconds`,
      )
      .run({
        key: entry.key,
        value: entry.value,
        agentId: entry.agentId,
        sourceHash: entry.sourceHash,
        createdAt: entry.createdAt,
        ttlSeconds: entry.ttlSeconds,
      });
  }

  getKnowledge(key: string): KnowledgeEntry | undefined {
    const row = this.db.prepare('SELECT * FROM knowledge WHERE key = ?').get(key) as
      | KnowledgeRow
      | undefined;
    return row ? rowToKnowledge(row) : undefined;
  }

  getAllKnowledge(): readonly KnowledgeEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM knowledge ORDER BY created_at')
      .all() as KnowledgeRow[];
    return rows.map(rowToKnowledge);
  }

  deleteKnowledge(key: string): void {
    this.db.prepare('DELETE FROM knowledge WHERE key = ?').run(key);
  }

  deleteExpiredKnowledge(now: ISOTimestamp): number {
    const result = this.db
      .prepare(
        `DELETE FROM knowledge
         WHERE ttl_seconds IS NOT NULL
         AND datetime(created_at, '+' || ttl_seconds || ' seconds') < datetime(?)`,
      )
      .run(now);
    return result.changes;
  }

  countKnowledge(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM knowledge').get() as {
      count: number;
    };
    return row.count;
  }

  deleteOldestKnowledge(keepCount: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM knowledge WHERE key NOT IN (
           SELECT key FROM knowledge ORDER BY created_at DESC LIMIT ?
         )`,
      )
      .run(keepCount);
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------

  insertDecision(decision: Decision): void {
    this.db
      .prepare(
        `INSERT INTO decisions (id, agent_id, category, summary, rationale, timestamp)
         VALUES (@id, @agentId, @category, @summary, @rationale, @timestamp)`,
      )
      .run({
        id: decision.id,
        agentId: decision.agentId,
        category: decision.category,
        summary: decision.summary,
        rationale: decision.rationale,
        timestamp: decision.timestamp,
      });
  }

  getDecision(id: DecisionId): Decision | undefined {
    const row = this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as
      | DecisionRow
      | undefined;
    return row ? rowToDecision(row) : undefined;
  }

  getAllDecisions(): readonly Decision[] {
    const rows = this.db
      .prepare('SELECT * FROM decisions ORDER BY timestamp')
      .all() as DecisionRow[];
    return rows.map(rowToDecision);
  }

  getDecisionsByCategory(category: DecisionCategory): readonly Decision[] {
    const rows = this.db
      .prepare('SELECT * FROM decisions WHERE category = ? ORDER BY timestamp')
      .all(category) as DecisionRow[];
    return rows.map(rowToDecision);
  }

  // -------------------------------------------------------------------------
  // Conflicts
  // -------------------------------------------------------------------------

  insertConflict(conflict: Conflict): void {
    this.db
      .prepare(
        `INSERT INTO conflicts (id, type, severity, agent_a, agent_b, file_paths, description, resolved, detected_at)
         VALUES (@id, @type, @severity, @agentA, @agentB, @filePaths, @description, @resolved, @detectedAt)`,
      )
      .run({
        id: conflict.id,
        type: conflict.type,
        severity: conflict.severity,
        agentA: conflict.agentA,
        agentB: conflict.agentB,
        filePaths: JSON.stringify(conflict.filePaths),
        description: conflict.description,
        resolved: conflict.resolved ? 1 : 0,
        detectedAt: conflict.detectedAt,
      });
  }

  getConflict(id: ConflictId): Conflict | undefined {
    const row = this.db.prepare('SELECT * FROM conflicts WHERE id = ?').get(id) as
      | ConflictRow
      | undefined;
    return row ? rowToConflict(row) : undefined;
  }

  getAllConflicts(): readonly Conflict[] {
    const rows = this.db
      .prepare('SELECT * FROM conflicts ORDER BY detected_at')
      .all() as ConflictRow[];
    return rows.map(rowToConflict);
  }

  getUnresolvedConflicts(): readonly Conflict[] {
    const rows = this.db
      .prepare('SELECT * FROM conflicts WHERE resolved = 0 ORDER BY detected_at')
      .all() as ConflictRow[];
    return rows.map(rowToConflict);
  }

  resolveConflict(id: ConflictId): void {
    this.db.prepare('UPDATE conflicts SET resolved = 1 WHERE id = ?').run(id);
  }

  // -------------------------------------------------------------------------
  // Invites
  // -------------------------------------------------------------------------

  insertInvite(invite: InviteRow): void {
    this.db
      .prepare(
        `INSERT INTO invites (code, created_by, created_at, expires_at, label)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(invite.code, invite.created_by, invite.created_at, invite.expires_at, invite.label);
  }

  /** Lookup a non-expired, non-consumed invite. Returns row or undefined. */
  getRedeemableInvite(code: string, now: string): InviteRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM invites
         WHERE code = ? AND consumed_at IS NULL AND expires_at > ?`,
      )
      .get(code, now) as InviteRow | undefined;
  }

  markInviteConsumed(code: string, joinTokenId: string, ip: string, now: string): void {
    this.db
      .prepare(
        `UPDATE invites SET consumed_at = ?, consumed_by = ?, consumed_ip = ?
         WHERE code = ? AND consumed_at IS NULL`,
      )
      .run(now, joinTokenId, ip, code);
  }

  deleteInvite(code: string): boolean {
    const r = this.db.prepare('DELETE FROM invites WHERE code = ?').run(code);
    return r.changes > 0;
  }

  /** All invites. Optionally filter by creator. */
  getAllInvites(createdBy?: string): readonly InviteRow[] {
    if (createdBy === undefined) {
      return this.db.prepare('SELECT * FROM invites ORDER BY created_at DESC').all() as InviteRow[];
    }
    return this.db
      .prepare('SELECT * FROM invites WHERE created_by = ? ORDER BY created_at DESC')
      .all(createdBy) as InviteRow[];
  }

  /** Count outstanding (non-consumed, non-expired) invites for a creator. */
  countOutstandingInvitesBy(createdBy: string, now: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM invites
         WHERE created_by = ? AND consumed_at IS NULL AND expires_at > ?`,
      )
      .get(createdBy, now) as { count: number };
    return row.count;
  }

  deleteExpiredInvites(now: string): number {
    return this.db
      .prepare('DELETE FROM invites WHERE consumed_at IS NULL AND expires_at <= ?')
      .run(now).changes;
  }

  // -------------------------------------------------------------------------
  // Join tokens
  // -------------------------------------------------------------------------

  insertJoinToken(token: JoinTokenRow): void {
    this.db
      .prepare(
        `INSERT INTO join_tokens (id, token_hash, created_at, invite_code, label)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(token.id, token.token_hash, token.created_at, token.invite_code, token.label);
  }

  getJoinTokenByHash(tokenHash: string): JoinTokenRow | undefined {
    return this.db
      .prepare('SELECT * FROM join_tokens WHERE token_hash = ? AND revoked = 0')
      .get(tokenHash) as JoinTokenRow | undefined;
  }

  getJoinTokenById(id: string): JoinTokenRow | undefined {
    return this.db.prepare('SELECT * FROM join_tokens WHERE id = ?').get(id) as
      | JoinTokenRow
      | undefined;
  }

  getAllJoinTokens(): readonly JoinTokenRow[] {
    return this.db
      .prepare('SELECT * FROM join_tokens ORDER BY created_at DESC')
      .all() as JoinTokenRow[];
  }

  recordJoinTokenUse(id: string, now: string): void {
    this.db
      .prepare(
        'UPDATE join_tokens SET last_used_at = ?, agent_count = agent_count + 1 WHERE id = ?',
      )
      .run(now, id);
  }

  revokeJoinToken(id: string): boolean {
    return this.db.prepare('UPDATE join_tokens SET revoked = 1 WHERE id = ?').run(id).changes > 0;
  }

  // -------------------------------------------------------------------------
  // Messages (DMs + broadcasts)
  // -------------------------------------------------------------------------

  insertMessage(msg: MessageRow): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, from_agent_id, to_agent_id, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(msg.id, msg.from_agent_id, msg.to_agent_id, msg.content, msg.created_at);
  }

  /**
   * Messages visible to an agent: broadcasts (to_agent_id IS NULL),
   * DMs to them, and DMs they sent. Optionally filter by `since` timestamp.
   */
  getMessagesForAgent(
    agentIdVal: AgentId,
    since: string | null,
    limit: number,
  ): readonly MessageRow[] {
    const sinceClause = since ? 'AND created_at > ?' : '';
    const params: unknown[] = [agentIdVal, agentIdVal];
    if (since) params.push(since);
    params.push(limit);
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE (to_agent_id IS NULL OR to_agent_id = ? OR from_agent_id = ?)
         ${sinceClause}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...params) as MessageRow[];
  }

  /** Admin view: all messages, paginated. */
  getAllMessages(since: string | null, limit: number): readonly MessageRow[] {
    if (since) {
      return this.db
        .prepare('SELECT * FROM messages WHERE created_at > ? ORDER BY created_at DESC LIMIT ?')
        .all(since, limit) as MessageRow[];
    }
    return this.db
      .prepare('SELECT * FROM messages ORDER BY created_at DESC LIMIT ?')
      .all(limit) as MessageRow[];
  }

  getMessageById(id: string): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
  }

  deleteMessage(id: string): boolean {
    return this.db.prepare('DELETE FROM messages WHERE id = ?').run(id).changes > 0;
  }

  // -------------------------------------------------------------------------
  // Agent metadata (git status, last run, etc.)
  // -------------------------------------------------------------------------

  upsertAgentMetadata(agentIdVal: AgentId, key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO agent_metadata (agent_id, key, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id, key) DO UPDATE SET value = ?, updated_at = ?`,
      )
      .run(agentIdVal, key, value, isoTimestamp(), value, isoTimestamp());
  }

  getAgentMetadata(agentIdVal: AgentId): Record<string, { value: string; updatedAt: string }> {
    const rows = this.db
      .prepare('SELECT key, value, updated_at FROM agent_metadata WHERE agent_id = ?')
      .all(agentIdVal) as { key: string; value: string; updated_at: string }[];
    const out: Record<string, { value: string; updatedAt: string }> = {};
    for (const r of rows) {
      out[r.key] = { value: r.value, updatedAt: r.updated_at };
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------

  /**
   * Execute a function inside a SQLite transaction.
   * Automatically commits on success, rolls back on error.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

// ---------------------------------------------------------------------------
// Invite & Join Token row types (exported for service layer)
// ---------------------------------------------------------------------------

export interface InviteRow {
  code: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  consumed_by: string | null;
  consumed_ip: string | null;
  label: string | null;
}

export interface JoinTokenRow {
  id: string;
  token_hash: string;
  created_at: string;
  invite_code: string | null;
  label: string | null;
  last_used_at: string | null;
  agent_count: number;
  revoked: number;
}

export interface MessageRow {
  id: string;
  from_agent_id: string;
  to_agent_id: string | null;
  content: string;
  created_at: string;
}
