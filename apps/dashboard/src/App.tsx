import { useEffect, useState } from 'react';
import { AgentGraph } from './components/AgentGraph';
import { api, ApiError } from './lib/api';
import { WsClient } from './lib/ws';
import type { Agent, ServerMessage } from './lib/types';

type ProbeState = 'pending' | 'ready' | 'auth-required' | 'unreachable';

export function App(): React.JSX.Element {
  const [probe, setProbe] = useState<ProbeState>('pending');
  const [agents, setAgents] = useState<readonly Agent[]>([]);

  // Probe the API. The hive defaults to `readAccess: open`, so reads
  // succeed without a token. If they don't, fail loudly instead of
  // showing a login form — the dashboard is intentionally tokenless.
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
      }
    };

    const ws = new WsClient({
      token: null,
      onMessage: handleMessage,
      onStatusChange: () => {
        // Reserved for future header indicator. The simulation breathes
        // even when WS is disconnected, so we don't surface this state
        // visually for now.
      },
    });
    ws.connect();
    return () => {
      ws.close();
    };
  }, [probe]);

  if (probe === 'pending') {
    return <div className="app-shell" />;
  }

  if (probe === 'auth-required') {
    return (
      <div className="error-shell">
        <div className="error-card">
          <h2>Restricted</h2>
          <p>
            This hive runs in <code>required</code> read-access mode. Set{' '}
            <code>CHM_READ_ACCESS=open</code> on the host or restart with the default config.
          </p>
        </div>
      </div>
    );
  }

  if (probe === 'unreachable') {
    return (
      <div className="error-shell">
        <div className="error-card">
          <h2>Hive offline</h2>
          <p>Could not reach the coordination server.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="accent">·</span>&nbsp;&nbsp;Hive Mind
        </div>
        <div className="meta">
          <span className="count">{agents.length}</span>
          {agents.length === 1 ? 'agent' : 'agents'}
        </div>
      </header>
      <main className="graph-stage">
        {agents.length === 0 ? (
          <div className="graph-empty">
            <div className="ring">awaiting agents</div>
          </div>
        ) : (
          <AgentGraph agents={agents} />
        )}
      </main>
    </div>
  );
}
