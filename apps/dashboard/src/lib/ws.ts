/**
 * WebSocket client with auto-reconnect.
 *
 * Browsers can't set custom Authorization headers on WebSocket. We pass the
 * token as a `?token=` query parameter — the hive server accepts both forms
 * (header for CLI clients, query for browser clients). Token-in-URL is a
 * known browser limitation; mitigated by the LAN/Tailscale trust model.
 */

import type { ServerMessage } from './types';

export interface WsClientOptions {
  readonly token: string;
  readonly onMessage: (msg: ServerMessage) => void;
  readonly onStatusChange: (connected: boolean) => void;
}

export class WsClient {
  private socket: WebSocket | null = null;
  private readonly token: string;
  private readonly onMessage: (msg: ServerMessage) => void;
  private readonly onStatusChange: (connected: boolean) => void;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs = 1_000;
  private closed = false;

  constructor(opts: WsClientOptions) {
    this.token = opts.token;
    this.onMessage = opts.onMessage;
    this.onStatusChange = opts.onStatusChange;
  }

  connect(): void {
    this.closed = false;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const host = window.location.host;
    const url = `${protocol}://${host}/ws?token=${encodeURIComponent(this.token)}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.retryDelayMs = 1_000;
      this.onStatusChange(true);
    });

    socket.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data as string) as ServerMessage;
        this.onMessage(data);
      } catch {
        // ignore malformed events
      }
    });

    socket.addEventListener('close', () => {
      this.onStatusChange(false);
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // The 'close' event fires too; let it handle reconnect.
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.retryDelayMs);
    // Exponential backoff capped at 30s.
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 30_000);
  }
}
