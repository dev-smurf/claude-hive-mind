/**
 * Thin REST client — wraps fetch with the bearer token automatically attached.
 *
 * In production the dashboard is served at the same origin as the API so
 * relative URLs work directly. In dev the Vite proxy forwards `/api` to
 * the hive server.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? null : JSON.stringify(body),
  });

  if (!res.ok) {
    let msg = `${method} ${path} failed (${String(res.status)})`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) msg = data.error;
    } catch {
      // body wasn't JSON; keep the default message
    }
    throw new ApiError(res.status, msg);
  }

  // 204 No Content
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>('GET', path),
  post: <T>(path: string, body?: unknown): Promise<T> => request<T>('POST', path, body),
  delete: <T>(path: string): Promise<T> => request<T>('DELETE', path),
};
