import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { setToken } from '../lib/auth';

interface LoginProps {
  readonly onAuthenticated: () => void;
}

export function Login({ onAuthenticated }: LoginProps): React.JSX.Element {
  const [token, setLocalToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!token.trim()) return;
    setLoading(true);
    setError(null);
    setToken(token.trim());
    try {
      // Validate the token by hitting an authed endpoint.
      await api.get('/api/agents');
      onAuthenticated();
    } catch (err: unknown) {
      const msg =
        err instanceof ApiError
          ? err.status === 401 || err.status === 403
            ? 'Invalid token'
            : err.message
          : 'Connection failed';
      setError(msg);
      setLoading(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <h1>Claude Hive Mind</h1>
        <p className="subtitle">Real-time view of your coordination layer.</p>
        <form className="login-form" onSubmit={(e) => void handleSubmit(e)}>
          <label htmlFor="token">Bearer token</label>
          <input
            id="token"
            type="password"
            placeholder="Admin or agent token"
            value={token}
            onChange={(e) => {
              setLocalToken(e.target.value);
            }}
            autoFocus
            spellCheck={false}
            autoComplete="off"
          />
          <button type="submit" disabled={loading || !token.trim()}>
            {loading ? 'Connecting…' : 'Connect'}
          </button>
          {error !== null && <div className="login-error">{error}</div>}
        </form>
      </div>
    </div>
  );
}
