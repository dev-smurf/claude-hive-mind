import { useCallback, useEffect, useState } from 'react';
import { Login } from './components/Login';
import { AgentGraph } from './components/AgentGraph';
import { api, ApiError } from './lib/api';
import { clearToken, getToken } from './lib/auth';
import { WsClient } from './lib/ws';
import type { Agent, ServerMessage } from './lib/types';

type AuthState = 'pending' | 'open' | 'authed' | 'login-required';

export function App(): React.JSX.Element {
  // 'pending' = haven't probed the server yet
  // 'open'    = anonymous read works (no token needed)
  // 'authed'  = token validated
  // 'login-required' = server needs a token; show the login screen
  const [authState, setAuthState] = useState<AuthState>('pending');
  const [agents, setAgents] = useState<readonly Agent[]>([]);
  const [wsConnected, setWsConnected] = useState(false);

  // Probe the API on mount. If anonymous reads work, skip login entirely.
  // Otherwise show the login screen.
  useEffect(() => {
    void (async () => {
      try {
        await api.get<unknown>('/api/agents');
        setAuthState(getToken() !== null ? 'authed' : 'open');
      } catch (err: unknown) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          setAuthState('login-required');
        } else {
          // Network error — try to show login as fallback.
          setAuthState('login-required');
        }
      }
    })();
  }, []);

  const handleAuthenticated = useCallback(() => {
    setAuthState('authed');
  }, []);

  const handleLogout = useCallback(() => {
    clearToken();
    setAuthState('login-required');
    setAgents([]);
  }, []);

  // Initial fetch + WebSocket subscription. Runs once auth probe resolves.
  useEffect(() => {
    if (authState !== 'open' && authState !== 'authed') return;
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

    // WS connects with token if present, anonymously otherwise (the
    // server allows anonymous WS subscribers in 'open' read-access mode).
    const ws = new WsClient({
      token: getToken(),
      onMessage: handleMessage,
      onStatusChange: setWsConnected,
    });
    ws.connect();

    return () => {
      cancelled = true;
      ws.close();
    };
  }, [authState, handleLogout]);

  if (authState === 'pending') {
    return <div className="login-shell" />;
  }
  if (authState === 'login-required') {
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
