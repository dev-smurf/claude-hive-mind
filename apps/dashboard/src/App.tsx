import { useCallback, useEffect, useState } from 'react';
import { Login } from './components/Login';
import { AgentGraph } from './components/AgentGraph';
import { api, ApiError } from './lib/api';
import { clearToken, getToken } from './lib/auth';
import { WsClient } from './lib/ws';
import type { Agent, ServerMessage } from './lib/types';

export function App(): React.JSX.Element {
  const [authed, setAuthed] = useState<boolean>(() => getToken() !== null);
  const [agents, setAgents] = useState<readonly Agent[]>([]);
  const [wsConnected, setWsConnected] = useState(false);

  const handleAuthenticated = useCallback(() => {
    setAuthed(true);
  }, []);

  const handleLogout = useCallback(() => {
    clearToken();
    setAuthed(false);
    setAgents([]);
  }, []);

  // Initial fetch + WebSocket subscription. Re-runs only when auth state
  // flips so login/logout cleanly tear down the previous socket.
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;

    const handleMessage = (msg: ServerMessage): void => {
      if (msg.type === 'agent_joined') {
        const a = (msg as { agent: Agent }).agent;
        setAgents((prev) => {
          // Replace if exists, append otherwise.
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
      // Other event types (file_claimed, message_received, etc.) ignored
      // for this first iteration — agents-only view.
    };

    // Initial REST fetch so we have the current state on page load.
    void (async () => {
      try {
        const list = await api.get<Agent[]>('/api/agents');
        if (!cancelled) setAgents(list);
      } catch (err: unknown) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          handleLogout();
        }
      }
    })();

    const token = getToken();
    if (!token) {
      handleLogout();
      return;
    }
    const ws = new WsClient({
      token,
      onMessage: handleMessage,
      onStatusChange: setWsConnected,
    });
    ws.connect();

    return () => {
      cancelled = true;
      ws.close();
    };
  }, [authed, handleLogout]);

  if (!authed) {
    return <Login onAuthenticated={handleAuthenticated} />;
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className={`dot ${wsConnected ? '' : 'disconnected'}`} />
          <span>Claude Hive Mind</span>
        </div>
        <div className="meta">
          <span className="count">
            {agents.length} agent{agents.length === 1 ? '' : 's'}
          </span>
          <button className="logout" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </header>
      <main className="graph-stage">
        {agents.length === 0 ? (
          <div className="graph-empty">
            <div>No agents connected.</div>
            <div className="hint">
              Tell a teammate to run <code>hive_connect</code> in their Claude session.
            </div>
          </div>
        ) : (
          <AgentGraph agents={agents} />
        )}
      </main>
    </div>
  );
}
