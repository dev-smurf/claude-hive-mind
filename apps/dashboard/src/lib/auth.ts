/**
 * Auth helpers — store the bearer token in sessionStorage so it survives a
 * page reload but doesn't persist across browser tabs/sessions.
 *
 * NOTE: storing tokens in sessionStorage is the standard pattern for
 * browser SPAs. The hive runs on a private network (LAN/Tailscale) so
 * the trust model is acceptable. For wider deployments, prefer HTTP-only
 * cookies via a server-side login endpoint.
 */

const TOKEN_KEY = 'chm.dashboard.token';

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}
