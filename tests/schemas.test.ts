import { describe, expect, it } from 'vitest';
import {
  agentRecordSchema,
  fileOwnershipSchema,
  taskSchema,
  knowledgeEntrySchema,
  decisionSchema,
  conflictSchema,
  hiveMindStateSchema,
  hiveMindStatusSchema,
  serverMessageSchema,
  clientMessageSchema,
  agentStatusSchema,
  agentToolSchema,
  ownershipModeSchema,
  taskStatusSchema,
  taskPrioritySchema,
  decisionCategorySchema,
  conflictTypeSchema,
  conflictSeveritySchema,
  isoTimestampSchema,
  agentId,
  taskId,
  conflictId,
  decisionId,
  isoTimestamp,
} from '../src/schemas.js';
import {
  AGENT_GABRIEL,
  AGENT_ALICE,
  AGENT_IDLE,
  OWNERSHIP_EXCLUSIVE,
  OWNERSHIP_SHARED,
  TASK_PENDING,
  TASK_IN_PROGRESS,
  KNOWLEDGE_FILE_SUMMARY,
  KNOWLEDGE_PATTERN,
  DECISION_AUTH,
  DECISION_DB,
  CONFLICT_FILE,
  FULL_STATE,
  COMPACT_STATUS,
  SERVER_MESSAGES,
  CLIENT_MESSAGES,
} from './fixtures/valid-data.js';

// ---------------------------------------------------------------------------
// ID factory helpers
// ---------------------------------------------------------------------------

describe('ID factories', () => {
  it('agentId creates a branded string', () => {
    const id = agentId('test-agent');
    expect(id).toBe('test-agent');
    // TypeScript ensures this is branded — runtime it's just a string
    expect(typeof id).toBe('string');
  });

  it('taskId creates a branded string', () => {
    const id = taskId('test-task');
    expect(id).toBe('test-task');
  });

  it('conflictId creates a branded string', () => {
    const id = conflictId('test-conflict');
    expect(id).toBe('test-conflict');
  });

  it('decisionId creates a branded string', () => {
    const id = decisionId('test-decision');
    expect(id).toBe('test-decision');
  });

  it('isoTimestamp creates an ISO string from a Date', () => {
    const ts = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
    expect(ts).toBe('2026-01-01T00:00:00.000Z');
  });

  it('isoTimestamp defaults to now', () => {
    const before = new Date().toISOString();
    const ts = isoTimestamp();
    const after = new Date().toISOString();
    expect(ts >= before).toBe(true);
    expect(ts <= after).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ISO timestamp schema
// ---------------------------------------------------------------------------

describe('isoTimestampSchema', () => {
  it('accepts valid ISO 8601 timestamps', () => {
    expect(isoTimestampSchema.safeParse('2026-04-28T12:00:00.000Z').success).toBe(true);
    expect(isoTimestampSchema.safeParse('2026-01-01T00:00:00Z').success).toBe(true);
  });

  it('rejects invalid timestamps', () => {
    expect(isoTimestampSchema.safeParse('not-a-date').success).toBe(false);
    expect(isoTimestampSchema.safeParse('2026-13-01T00:00:00Z').success).toBe(false);
    expect(isoTimestampSchema.safeParse('').success).toBe(false);
    expect(isoTimestampSchema.safeParse(12345).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Enum schemas
// ---------------------------------------------------------------------------

describe('enum schemas', () => {
  describe('agentStatusSchema', () => {
    it.each(['active', 'idle', 'busy', 'disconnected'])('accepts "%s"', (value) => {
      expect(agentStatusSchema.safeParse(value).success).toBe(true);
    });

    it('rejects invalid values', () => {
      expect(agentStatusSchema.safeParse('online').success).toBe(false);
      expect(agentStatusSchema.safeParse('').success).toBe(false);
      expect(agentStatusSchema.safeParse(null).success).toBe(false);
    });
  });

  describe('agentToolSchema', () => {
    it.each(['claude-code', 'cursor', 'copilot', 'codex', 'windsurf', 'other'])(
      'accepts "%s"',
      (value) => {
        expect(agentToolSchema.safeParse(value).success).toBe(true);
      },
    );

    it('rejects unknown tools', () => {
      expect(agentToolSchema.safeParse('vim').success).toBe(false);
    });
  });

  describe('ownershipModeSchema', () => {
    it.each(['exclusive', 'shared'])('accepts "%s"', (value) => {
      expect(ownershipModeSchema.safeParse(value).success).toBe(true);
    });

    it('rejects invalid modes', () => {
      expect(ownershipModeSchema.safeParse('readonly').success).toBe(false);
    });
  });

  describe('taskStatusSchema', () => {
    it.each(['pending', 'in_progress', 'completed', 'failed', 'cancelled'])(
      'accepts "%s"',
      (value) => {
        expect(taskStatusSchema.safeParse(value).success).toBe(true);
      },
    );
  });

  describe('taskPrioritySchema', () => {
    it.each(['low', 'medium', 'high', 'critical'])('accepts "%s"', (value) => {
      expect(taskPrioritySchema.safeParse(value).success).toBe(true);
    });
  });

  describe('decisionCategorySchema', () => {
    it.each([
      'architecture',
      'api-design',
      'database',
      'dependency',
      'convention',
      'security',
      'performance',
      'other',
    ])('accepts "%s"', (value) => {
      expect(decisionCategorySchema.safeParse(value).success).toBe(true);
    });
  });

  describe('conflictTypeSchema', () => {
    it.each(['file_contention', 'task_overlap', 'decision_contradiction', 'dependency_break'])(
      'accepts "%s"',
      (value) => {
        expect(conflictTypeSchema.safeParse(value).success).toBe(true);
      },
    );
  });

  describe('conflictSeveritySchema', () => {
    it.each(['low', 'medium', 'high', 'critical'])('accepts "%s"', (value) => {
      expect(conflictSeveritySchema.safeParse(value).success).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Domain object schemas — valid data
// ---------------------------------------------------------------------------

describe('agentRecordSchema', () => {
  it('accepts a valid active agent', () => {
    expect(agentRecordSchema.safeParse(AGENT_GABRIEL).success).toBe(true);
  });

  it('accepts a valid busy agent', () => {
    expect(agentRecordSchema.safeParse(AGENT_ALICE).success).toBe(true);
  });

  it('accepts a valid idle agent with null currentTaskId', () => {
    expect(agentRecordSchema.safeParse(AGENT_IDLE).success).toBe(true);
  });

  it('rejects agent with empty displayName', () => {
    const invalid = { ...AGENT_GABRIEL, displayName: '' };
    expect(agentRecordSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects agent with whitespace-only displayName', () => {
    const invalid = { ...AGENT_GABRIEL, displayName: '   ' };
    expect(agentRecordSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects agent with invalid status', () => {
    const invalid = { ...AGENT_GABRIEL, status: 'online' };
    expect(agentRecordSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects agent with invalid tool', () => {
    const invalid = { ...AGENT_GABRIEL, tool: 'vim' };
    expect(agentRecordSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects agent with invalid timestamp', () => {
    const invalid = { ...AGENT_GABRIEL, lastHeartbeat: 'not-a-date' };
    expect(agentRecordSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects agent missing required fields', () => {
    expect(agentRecordSchema.safeParse({}).success).toBe(false);
    expect(agentRecordSchema.safeParse({ id: 'x' }).success).toBe(false);
  });
});

describe('fileOwnershipSchema', () => {
  it('accepts a valid exclusive claim', () => {
    expect(fileOwnershipSchema.safeParse(OWNERSHIP_EXCLUSIVE).success).toBe(true);
  });

  it('accepts a valid shared claim with null taskId and expiresAt', () => {
    expect(fileOwnershipSchema.safeParse(OWNERSHIP_SHARED).success).toBe(true);
  });

  it('rejects empty filePath', () => {
    const invalid = { ...OWNERSHIP_EXCLUSIVE, filePath: '' };
    expect(fileOwnershipSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects invalid ownership mode', () => {
    const invalid = { ...OWNERSHIP_EXCLUSIVE, mode: 'readonly' };
    expect(fileOwnershipSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('taskSchema', () => {
  it('accepts a valid pending task', () => {
    expect(taskSchema.safeParse(TASK_PENDING).success).toBe(true);
  });

  it('accepts a valid in-progress task with dependencies', () => {
    expect(taskSchema.safeParse(TASK_IN_PROGRESS).success).toBe(true);
  });

  it('rejects task with empty title', () => {
    const invalid = { ...TASK_PENDING, title: '' };
    expect(taskSchema.safeParse(invalid).success).toBe(false);
  });

  it('accepts task with empty description', () => {
    const valid = { ...TASK_PENDING, description: '' };
    expect(taskSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects task with invalid status', () => {
    const invalid = { ...TASK_PENDING, status: 'done' };
    expect(taskSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects task with invalid priority', () => {
    const invalid = { ...TASK_PENDING, priority: 'urgent' };
    expect(taskSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('knowledgeEntrySchema', () => {
  it('accepts a valid entry with sourceHash and TTL', () => {
    expect(knowledgeEntrySchema.safeParse(KNOWLEDGE_FILE_SUMMARY).success).toBe(true);
  });

  it('accepts a valid entry with null sourceHash and TTL', () => {
    expect(knowledgeEntrySchema.safeParse(KNOWLEDGE_PATTERN).success).toBe(true);
  });

  it('rejects entry with empty key', () => {
    const invalid = { ...KNOWLEDGE_FILE_SUMMARY, key: '' };
    expect(knowledgeEntrySchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects entry with negative TTL', () => {
    const invalid = { ...KNOWLEDGE_FILE_SUMMARY, ttlSeconds: -1 };
    expect(knowledgeEntrySchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects entry with zero TTL', () => {
    const invalid = { ...KNOWLEDGE_FILE_SUMMARY, ttlSeconds: 0 };
    expect(knowledgeEntrySchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects entry with fractional TTL', () => {
    const invalid = { ...KNOWLEDGE_FILE_SUMMARY, ttlSeconds: 1.5 };
    expect(knowledgeEntrySchema.safeParse(invalid).success).toBe(false);
  });
});

describe('decisionSchema', () => {
  it('accepts a valid security decision', () => {
    expect(decisionSchema.safeParse(DECISION_AUTH).success).toBe(true);
  });

  it('accepts a valid database decision', () => {
    expect(decisionSchema.safeParse(DECISION_DB).success).toBe(true);
  });

  it('rejects decision with empty summary', () => {
    const invalid = { ...DECISION_AUTH, summary: '' };
    expect(decisionSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects decision with empty rationale', () => {
    const invalid = { ...DECISION_AUTH, rationale: '' };
    expect(decisionSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects decision with invalid category', () => {
    const invalid = { ...DECISION_AUTH, category: 'testing' };
    expect(decisionSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('conflictSchema', () => {
  it('accepts a valid file contention conflict', () => {
    expect(conflictSchema.safeParse(CONFLICT_FILE).success).toBe(true);
  });

  it('rejects conflict with empty description', () => {
    const invalid = { ...CONFLICT_FILE, description: '' };
    expect(conflictSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects conflict with invalid type', () => {
    const invalid = { ...CONFLICT_FILE, type: 'merge_conflict' };
    expect(conflictSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects conflict with invalid severity', () => {
    const invalid = { ...CONFLICT_FILE, severity: 'extreme' };
    expect(conflictSchema.safeParse(invalid).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Composite state schemas
// ---------------------------------------------------------------------------

describe('hiveMindStateSchema', () => {
  it('accepts a valid full state', () => {
    expect(hiveMindStateSchema.safeParse(FULL_STATE).success).toBe(true);
  });

  it('accepts an empty state', () => {
    const empty = {
      agents: [],
      files: [],
      tasks: [],
      knowledge: [],
      decisions: [],
      conflicts: [],
    };
    expect(hiveMindStateSchema.safeParse(empty).success).toBe(true);
  });

  it('rejects state with invalid agent inside array', () => {
    const invalid = { ...FULL_STATE, agents: [{ id: '' }] };
    expect(hiveMindStateSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('hiveMindStatusSchema', () => {
  it('accepts a valid compact status', () => {
    expect(hiveMindStatusSchema.safeParse(COMPACT_STATUS).success).toBe(true);
  });

  it('rejects negative activeAgents', () => {
    const invalid = { ...COMPACT_STATUS, activeAgents: -1 };
    expect(hiveMindStatusSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects fractional activeAgents', () => {
    const invalid = { ...COMPACT_STATUS, activeAgents: 1.5 };
    expect(hiveMindStatusSchema.safeParse(invalid).success).toBe(false);
  });

  it('accepts zero agents and tasks', () => {
    const minimal = {
      activeAgents: 0,
      agentSummaries: [],
      claimedFiles: [],
      activeConflicts: [],
      pendingTaskCount: 0,
      generatedAt: '2026-04-28T12:00:00.000Z',
    };
    expect(hiveMindStatusSchema.safeParse(minimal).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WebSocket message schemas
// ---------------------------------------------------------------------------

describe('serverMessageSchema', () => {
  it.each(SERVER_MESSAGES.map((msg, i) => [msg.type, msg, i] as const))(
    'accepts valid "%s" message',
    (_type, msg) => {
      const result = serverMessageSchema.safeParse(msg);
      if (!result.success) {
        // Print detailed error for debugging
        expect(result.error.issues).toEqual([]);
      }
      expect(result.success).toBe(true);
    },
  );

  it('rejects message with unknown type', () => {
    const invalid = { type: 'unknown_event', data: {} };
    expect(serverMessageSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects message missing required fields', () => {
    const invalid = { type: 'agent_joined' }; // missing agent
    expect(serverMessageSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects state_sync with invalid state', () => {
    const invalid = { type: 'state_sync', state: { agents: 'not-an-array' } };
    expect(serverMessageSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('clientMessageSchema', () => {
  it.each(CLIENT_MESSAGES.map((msg, i) => [msg.type, msg, i] as const))(
    'accepts valid "%s" message',
    (_type, msg) => {
      const result = clientMessageSchema.safeParse(msg);
      if (!result.success) {
        expect(result.error.issues).toEqual([]);
      }
      expect(result.success).toBe(true);
    },
  );

  it('rejects message with unknown type', () => {
    const invalid = { type: 'disconnect' };
    expect(clientMessageSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects register with empty displayName', () => {
    const invalid = {
      type: 'register',
      displayName: '',
      tool: 'claude-code',
      workspacePath: '/home',
    };
    expect(clientMessageSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects claim_files with empty filePaths array', () => {
    const invalid = { type: 'claim_files', filePaths: [], mode: 'exclusive', taskId: null };
    expect(clientMessageSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects release_files with empty filePaths array', () => {
    const invalid = { type: 'release_files', filePaths: [] };
    expect(clientMessageSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects register with invalid tool', () => {
    const invalid = {
      type: 'register',
      displayName: 'Test',
      tool: 'notepad',
      workspacePath: '/home',
    };
    expect(clientMessageSchema.safeParse(invalid).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases and type coercion
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('rejects undefined for required fields', () => {
    expect(agentRecordSchema.safeParse(undefined).success).toBe(false);
    expect(taskSchema.safeParse(undefined).success).toBe(false);
    expect(serverMessageSchema.safeParse(undefined).success).toBe(false);
  });

  it('rejects null for required fields', () => {
    expect(agentRecordSchema.safeParse(null).success).toBe(false);
    expect(taskSchema.safeParse(null).success).toBe(false);
  });

  it('rejects arrays where objects are expected', () => {
    expect(agentRecordSchema.safeParse([]).success).toBe(false);
    expect(conflictSchema.safeParse([]).success).toBe(false);
  });

  it('rejects numbers where strings are expected', () => {
    const invalid = { ...AGENT_GABRIEL, id: 12345 };
    expect(agentRecordSchema.safeParse(invalid).success).toBe(false);
  });

  it('strips extra fields (passthrough is not enabled)', () => {
    const withExtra = { ...AGENT_GABRIEL, extraField: 'should be stripped' };
    const result = agentRecordSchema.safeParse(withExtra);
    expect(result.success).toBe(true);
    if (result.success) {
      expect('extraField' in result.data).toBe(false);
    }
  });

  it('trims whitespace from string fields', () => {
    const padded = { ...AGENT_GABRIEL, displayName: '  Gabriel  ' };
    const result = agentRecordSchema.safeParse(padded);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.displayName).toBe('Gabriel');
    }
  });
});
