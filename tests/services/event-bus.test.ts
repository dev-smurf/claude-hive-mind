import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/services/event-bus.js';
import type { ServerMessage } from '../../src/types.js';
import { agentId, taskId, conflictId, decisionId, isoTimestamp } from '../../src/schemas.js';
import {
  AGENT_GABRIEL,
  CONFLICT_FILE,
  FULL_STATE,
  COMPACT_STATUS,
} from '../fixtures/valid-data.js';

let bus: EventBus;
type StderrSpy = ReturnType<typeof vi.spyOn<NodeJS.WriteStream, 'write'>>;
let stderrSpy: StderrSpy;

function stderrText(spy: StderrSpy): string {
  return spy.mock.calls.map((c) => String(c[0])).join('\n');
}

beforeEach(() => {
  bus = new EventBus();
  // Logger writes JSON lines to stderr; spy on it so error-isolation
  // tests can assert that listener errors are captured (not crashed on).
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  bus.clear();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Basic pub/sub
// ---------------------------------------------------------------------------

describe('on / emit', () => {
  it('delivers event to a matching listener', () => {
    const listener = vi.fn();
    bus.on('agent_joined', listener);

    const msg: ServerMessage = { type: 'agent_joined', agent: AGENT_GABRIEL };
    bus.emit(msg);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(msg);
  });

  it('does not deliver event to non-matching listener', () => {
    const listener = vi.fn();
    bus.on('agent_left', listener);

    bus.emit({ type: 'agent_joined', agent: AGENT_GABRIEL });

    expect(listener).not.toHaveBeenCalled();
  });

  it('delivers to multiple listeners on the same event', () => {
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    bus.on('agent_joined', listener1);
    bus.on('agent_joined', listener2);

    bus.emit({ type: 'agent_joined', agent: AGENT_GABRIEL });

    expect(listener1).toHaveBeenCalledOnce();
    expect(listener2).toHaveBeenCalledOnce();
  });

  it('delivers different events to different listeners', () => {
    const joinListener = vi.fn();
    const leaveListener = vi.fn();
    bus.on('agent_joined', joinListener);
    bus.on('agent_left', leaveListener);

    bus.emit({ type: 'agent_joined', agent: AGENT_GABRIEL });
    bus.emit({ type: 'agent_left', agentId: agentId('agent-gabriel-01') });

    expect(joinListener).toHaveBeenCalledOnce();
    expect(leaveListener).toHaveBeenCalledOnce();
  });

  it('does nothing when emitting with no listeners', () => {
    // Should not throw
    bus.emit({ type: 'agent_joined', agent: AGENT_GABRIEL });
  });

  it('prevents duplicate subscriptions of same function reference', () => {
    const listener = vi.fn();
    bus.on('agent_joined', listener);
    bus.on('agent_joined', listener); // same ref, Set deduplicates

    bus.emit({ type: 'agent_joined', agent: AGENT_GABRIEL });

    expect(listener).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Wildcard listener
// ---------------------------------------------------------------------------

describe('wildcard (*)', () => {
  it('receives all event types', () => {
    const listener = vi.fn();
    bus.on('*', listener);

    bus.emit({ type: 'agent_joined', agent: AGENT_GABRIEL });
    bus.emit({ type: 'agent_left', agentId: agentId('agent-gabriel-01') });
    bus.emit({ type: 'conflict_detected', conflict: CONFLICT_FILE });

    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('receives events alongside specific listeners', () => {
    const specific = vi.fn();
    const wildcard = vi.fn();
    bus.on('agent_joined', specific);
    bus.on('*', wildcard);

    bus.emit({ type: 'agent_joined', agent: AGENT_GABRIEL });

    expect(specific).toHaveBeenCalledOnce();
    expect(wildcard).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Unsubscribe
// ---------------------------------------------------------------------------

describe('unsubscribe', () => {
  it('stops receiving events after unsubscribe', () => {
    const listener = vi.fn();
    const unsub = bus.on('agent_joined', listener);

    bus.emit({ type: 'agent_joined', agent: AGENT_GABRIEL });
    expect(listener).toHaveBeenCalledOnce();

    unsub();
    bus.emit({ type: 'agent_joined', agent: AGENT_GABRIEL });
    expect(listener).toHaveBeenCalledOnce(); // still 1, not 2
  });

  it('unsubscribe is idempotent', () => {
    const listener = vi.fn();
    const unsub = bus.on('agent_joined', listener);

    unsub();
    unsub(); // second call should not throw
    unsub();

    expect(bus.listenerCount('agent_joined')).toBe(0);
  });

  it('cleans up empty listener sets', () => {
    const listener = vi.fn();
    const unsub = bus.on('agent_joined', listener);
    expect(bus.listenerCount('agent_joined')).toBe(1);

    unsub();
    expect(bus.listenerCount('agent_joined')).toBe(0);
  });

  it('only removes the specific listener, not others', () => {
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    const unsub1 = bus.on('agent_joined', listener1);
    bus.on('agent_joined', listener2);

    unsub1();
    bus.emit({ type: 'agent_joined', agent: AGENT_GABRIEL });

    expect(listener1).not.toHaveBeenCalled();
    expect(listener2).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// once
// ---------------------------------------------------------------------------

describe('once', () => {
  it('fires listener only once', () => {
    const listener = vi.fn();
    bus.once('agent_joined', listener);

    bus.emit({ type: 'agent_joined', agent: AGENT_GABRIEL });
    bus.emit({ type: 'agent_joined', agent: AGENT_GABRIEL });

    expect(listener).toHaveBeenCalledOnce();
  });

  it('can be cancelled before firing', () => {
    const listener = vi.fn();
    const unsub = bus.once('agent_joined', listener);

    unsub();
    bus.emit({ type: 'agent_joined', agent: AGENT_GABRIEL });

    expect(listener).not.toHaveBeenCalled();
  });

  it('works with wildcard', () => {
    const listener = vi.fn();
    bus.once('*', listener);

    bus.emit({ type: 'agent_joined', agent: AGENT_GABRIEL });
    bus.emit({ type: 'agent_left', agentId: agentId('agent-gabriel-01') });

    expect(listener).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('error isolation', () => {
  it('catches errors in specific listeners without crashing', () => {
    const bad = vi.fn(() => {
      throw new Error('listener exploded');
    });
    const good = vi.fn();
    bus.on('agent_joined', bad);
    bus.on('agent_joined', good);

    bus.emit({ type: 'agent_joined', agent: AGENT_GABRIEL });

    expect(bad).toHaveBeenCalledOnce();
    expect(good).toHaveBeenCalledOnce(); // still called despite bad listener
    const calls = stderrText(stderrSpy);
    expect(calls).toMatch(/Listener error/);
    expect(calls).toMatch(/agent_joined/);
  });

  it('catches errors in wildcard listeners without crashing', () => {
    const bad = vi.fn(() => {
      throw new Error('wildcard exploded');
    });
    bus.on('*', bad);

    bus.emit({ type: 'agent_joined', agent: AGENT_GABRIEL });

    const calls = stderrText(stderrSpy);
    expect(calls).toMatch(/Wildcard listener error/);
    expect(calls).toMatch(/agent_joined/);
  });

  it('one bad listener does not prevent others from firing', () => {
    const results: number[] = [];
    bus.on('error', () => {
      throw new Error('first fails');
    });
    bus.on('error', () => {
      results.push(2);
    });
    bus.on('error', () => {
      results.push(3);
    });

    bus.emit({ type: 'error', message: 'test error' });

    expect(results).toEqual([2, 3]);
  });
});

// ---------------------------------------------------------------------------
// listenerCount
// ---------------------------------------------------------------------------

describe('listenerCount', () => {
  it('returns 0 for no listeners', () => {
    expect(bus.listenerCount('agent_joined')).toBe(0);
    expect(bus.listenerCount('*')).toBe(0);
  });

  it('tracks listeners per event type', () => {
    bus.on('agent_joined', vi.fn());
    bus.on('agent_joined', vi.fn());
    bus.on('agent_left', vi.fn());

    expect(bus.listenerCount('agent_joined')).toBe(2);
    expect(bus.listenerCount('agent_left')).toBe(1);
    expect(bus.listenerCount('file_claimed')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

describe('clear', () => {
  it('removes all listeners', () => {
    bus.on('agent_joined', vi.fn());
    bus.on('agent_left', vi.fn());
    bus.on('*', vi.fn());

    bus.clear();

    expect(bus.listenerCount('agent_joined')).toBe(0);
    expect(bus.listenerCount('agent_left')).toBe(0);
    expect(bus.listenerCount('*')).toBe(0);
  });

  it('events emitted after clear are not received', () => {
    const listener = vi.fn();
    bus.on('agent_joined', listener);
    bus.clear();

    bus.emit({ type: 'agent_joined', agent: AGENT_GABRIEL });

    expect(listener).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// All ServerMessage types pass through
// ---------------------------------------------------------------------------

describe('all message types', () => {
  const allMessages: ServerMessage[] = [
    { type: 'state_sync', state: FULL_STATE },
    { type: 'agent_joined', agent: AGENT_GABRIEL },
    { type: 'agent_left', agentId: agentId('agent-01') },
    { type: 'agent_heartbeat', agentId: agentId('agent-01'), timestamp: isoTimestamp() },
    {
      type: 'file_claimed',
      ownership: {
        filePath: 'test.ts',
        agentId: agentId('agent-01'),
        mode: 'exclusive',
        taskId: null,
        claimedAt: isoTimestamp(),
        expiresAt: null,
      },
    },
    { type: 'file_released', filePath: 'test.ts', agentId: agentId('agent-01') },
    {
      type: 'task_created',
      task: {
        id: taskId('task-01'),
        title: 'Test',
        description: '',
        assignedAgentId: null,
        status: 'pending',
        priority: 'medium',
        filePaths: [],
        dependsOn: [],
        createdAt: isoTimestamp(),
        updatedAt: isoTimestamp(),
      },
    },
    {
      type: 'task_updated',
      task: {
        id: taskId('task-01'),
        title: 'Test',
        description: '',
        assignedAgentId: null,
        status: 'completed',
        priority: 'medium',
        filePaths: [],
        dependsOn: [],
        createdAt: isoTimestamp(),
        updatedAt: isoTimestamp(),
      },
    },
    {
      type: 'knowledge_shared',
      entry: {
        key: 'test',
        value: 'data',
        agentId: agentId('agent-01'),
        sourceHash: null,
        createdAt: isoTimestamp(),
        ttlSeconds: null,
      },
    },
    {
      type: 'decision_logged',
      decision: {
        id: decisionId('dec-01'),
        agentId: agentId('agent-01'),
        category: 'architecture',
        summary: 'Test',
        rationale: 'Because',
        timestamp: isoTimestamp(),
      },
    },
    { type: 'conflict_detected', conflict: CONFLICT_FILE },
    { type: 'conflict_resolved', conflictId: conflictId('conflict-01') },
    { type: 'status_update', status: COMPACT_STATUS },
    { type: 'error', message: 'Something went wrong' },
  ];

  it.each(allMessages.map((msg) => [msg.type, msg] as const))(
    'delivers "%s" to wildcard listener',
    (_type, msg) => {
      const listener = vi.fn();
      bus.on('*', listener);

      bus.emit(msg);

      expect(listener).toHaveBeenCalledWith(msg);
    },
  );
});
