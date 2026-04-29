import { useEffect, useMemo, useState } from 'react';
import {
  ACTIVITY_DURATION_MS,
  AgentGraph,
  type ActivityKind,
  type AgentActivity,
  type CommPing,
  PING_DURATION_MS,
} from './components/AgentGraph';
import { AgentPanel } from './components/AgentPanel';
import { api, ApiError } from './lib/api';
import { WsClient } from './lib/ws';
import type { Agent, ServerMessage } from './lib/types';

type ProbeState = 'pending' | 'ready' | 'auth-required' | 'unreachable';

export function App(): React.JSX.Element {
  const [probe, setProbe] = useState<ProbeState>('pending');
  const [agents, setAgents] = useState<readonly Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pings, setPings] = useState<readonly CommPing[]>([]);
  const [activities, setActivities] = useState<ReadonlyMap<string, AgentActivity>>(
    new Map(),
  );

  const selectedAgent = useMemo(
    () => agents.find((a) => a.id === selectedId) ?? null,
    [agents, selectedId],
  );

  // Drop the selection if the selected agent disappears.
  useEffect(() => {
    if (selectedId !== null && selectedAgent === null) setSelectedId(null);
  }, [selectedId, selectedAgent]);

  // Probe the API. The hive defaults to readAccess=open so reads succeed
  // without a token. Otherwise show a clean error card with the fix.
  useEffect(() => {
    void (async () => {
      try {
        const list = await api.get<Agent[]>('/api/agents');
        setAgents(list);
        setProbe('ready');
      } catch (err: unknown) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          setProbe('auth-required');
        } else {
          setProbe('unreachable');
        }
      }
    })();
  }, []);

  useEffect(() => {
    if (probe !== 'ready') return;

    const pushPing = (ping: CommPing): void => {
      setPings((prev) => [...prev, ping]);
      window.setTimeout(() => {
        setPings((prev) => prev.filter((p) => p.id !== ping.id));
      }, PING_DURATION_MS + 50);
    };

    const setActivity = (agentId: string, kind: ActivityKind): void => {
      setActivities((prev) => {
        const next = new Map(prev);
        next.set(agentId, { kind, since: performance.now() });
        return next;
      });
    };

    const handleMessage = (msg: ServerMessage): void => {
      if (msg.type === 'agent_joined') {
        const a = (msg as { agent: Agent }).agent;
        setAgents((prev) => {
          const idx = prev.findIndex((x) => x.id === a.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = a;
            return next;
          }
          return [...prev, a];
        });
      } else if (msg.type === 'agent_left') {
        const aid = (msg as { agentId: string }).agentId;
        setAgents((prev) => prev.filter((x) => x.id !== aid));
      } else if (msg.type === 'agent_heartbeat') {
        const aid = (msg as { agentId: string }).agentId;
        setAgents((prev) =>
          prev.map((x) =>
            x.id === aid && x.status === 'disconnected' ? { ...x, status: 'active' } : x,
          ),
        );
      } else if (msg.type === 'message_received') {
        const m = (msg as unknown as {
          message: { id: string; fromAgentId: string; toAgentId: string | null };
        }).message;
        pushPing({
          id: `m-${m.id}-${String(performance.now())}`,
          kind: 'message',
          fromId: m.fromAgentId,
          toId: m.toAgentId,
          startTs: performance.now(),
        });
        setActivity(m.fromAgentId, 'talking');
      } else if (msg.type === 'decision_logged') {
        const d = (msg as unknown as { decision: { id: string; agentId: string } }).decision;
        pushPing({
          id: `d-${d.id}-${String(performance.now())}`,
          kind: 'decision',
          fromId: d.agentId,
          toId: null,
          startTs: performance.now(),
        });
        setActivity(d.agentId, 'thinking');
      } else if (msg.type === 'knowledge_shared') {
        const k = (msg as unknown as { entry: { key: string; agentId: string } }).entry;
        pushPing({
          id: `k-${k.key}-${String(performance.now())}`,
          kind: 'knowledge',
          fromId: k.agentId,
          toId: null,
          startTs: performance.now(),
        });
        setActivity(k.agentId, 'sharing');
      } else if (msg.type === 'file_claimed') {
        const o = (msg as unknown as { ownership: { agentId: string } }).ownership;
        setActivity(o.agentId, 'editing');
      }
    };

    const ws = new WsClient({
      token: null,
      onMessage: handleMessage,
      onStatusChange: () => {
        // Reserved for a future header indicator.
      },
    });
    ws.connect();
    return () => {
      ws.close();
    };
  }, [probe]);

  // Prune expired activity entries so the map doesn't grow unbounded.
  useEffect(() => {
    if (activities.size === 0) return;
    const id = window.setInterval(() => {
      setActivities((prev) => {
        const now = performance.now();
        let changed = false;
        const next = new Map(prev);
        for (const [k, v] of prev) {
          if (now - v.since >= ACTIVITY_DURATION_MS) {
            next.delete(k);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [activities.size === 0]);

  if (probe === 'pending') {
    return <div className="h-full" />;
  }

  if (probe === 'auth-required') {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="max-w-md rounded-xl border border-border bg-surface p-7 text-center shadow-sm">
          <h2 className="mb-2 text-[15px] font-semibold tracking-tight text-text">
            Restricted
          </h2>
          <p className="m-0 text-[13px] leading-6 text-muted">
            This hive runs in <code className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-[12px] text-accent">required</code> read-access mode. Set{' '}
            <code className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-[12px] text-accent">CHM_READ_ACCESS=open</code> on the host or restart with the default config.
          </p>
        </div>
      </div>
    );
  }

  if (probe === 'unreachable') {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="max-w-md rounded-xl border border-border bg-surface p-7 text-center shadow-sm">
          <h2 className="mb-2 text-[15px] font-semibold tracking-tight text-text">
            Hive offline
          </h2>
          <p className="m-0 text-[13px] leading-6 text-muted">
            Could not reach the coordination server.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-surface px-7 py-4">
        <div className="text-[14px] font-semibold tracking-tight text-text">
          Hive Mind
        </div>
        <div className="text-[13px] text-muted tabular-nums">
          <span className="font-medium text-text">{agents.length}</span>{' '}
          {agents.length === 1 ? 'agent' : 'agents'} connected
        </div>
      </header>
      <main className="graph-stage-grid relative flex-1 overflow-hidden">
        {agents.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="text-center">
              <div className="mb-1 text-[14px] font-medium text-text">
                No agents connected
              </div>
              <div className="text-[13px] text-dim">
                Tell a teammate to call{' '}
                <code className="rounded bg-bg-grid px-1.5 py-0.5 font-mono text-[12px] text-muted">
                  hive_connect
                </code>{' '}
                in their session.
              </div>
            </div>
          </div>
        ) : (
          <AgentGraph
            agents={agents}
            selectedId={selectedId}
            onSelectAgent={setSelectedId}
            pings={pings}
            activities={activities}
          />
        )}
        {selectedAgent !== null && (
          <AgentPanel
            agent={selectedAgent}
            agents={agents}
            onClose={() => setSelectedId(null)}
          />
        )}
      </main>
    </div>
  );
}
