import type { WsInboundMessage, WsOutboundMessage } from '@clauder/shared';

export type WsMessageHandler = (msg: WsOutboundMessage) => void;

const PREFERRED_URL_KEY = 'clauder.preferredWsUrl';
/** If a connection attempt hasn't opened within this long, treat it as failed and rotate to
 *  the next candidate host rather than waiting on the browser's own (much longer) WS timeout. */
const CONNECT_TIMEOUT_MS = 6000;

export class WsClient {
  private ws: WebSocket | null = null;
  private urls: string[];
  private urlIndex = 0;
  private onMessage: WsMessageHandler;
  private onStatusChange: (connected: boolean) => void;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private destroyed = false;

  /** Accepts one or more candidate URLs (e.g. the current origin plus known alternate
   *  hostnames — see lib/hosts.ts). Tries them in order; on failure/timeout, rotates to the
   *  next one on each retry so a flaky path (Tailscale relay down, LAN hiccup, etc.) doesn't
   *  get stuck retrying itself forever while a working alternate sits unused. Remembers
   *  whichever URL last connected successfully and tries that one first on future loads. */
  constructor(
    urls: string | string[],
    onMessage: WsMessageHandler,
    onStatusChange: (connected: boolean) => void,
  ) {
    this.urls = Array.isArray(urls) ? [...urls] : [urls];
    if (this.urls.length === 0) throw new Error('WsClient requires at least one URL');

    let preferred: string | null = null;
    try { preferred = localStorage.getItem(PREFERRED_URL_KEY); } catch { /* ignore */ }
    if (preferred) {
      const idx = this.urls.indexOf(preferred);
      if (idx > 0) this.urls = [preferred, ...this.urls.filter(u => u !== preferred)];
    }

    this.onMessage = onMessage;
    this.onStatusChange = onStatusChange;
  }

  connect() {
    if (this.destroyed) return;
    const url = this.urls[this.urlIndex % this.urls.length];

    try {
      this.ws = new WebSocket(url);

      this.connectTimer = setTimeout(() => {
        if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
          this.ws.close(); // triggers onclose, which rotates to the next candidate
        }
      }, CONNECT_TIMEOUT_MS);

      this.ws.onopen = () => {
        if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
        this.reconnectDelay = 1000;
        try { localStorage.setItem(PREFERRED_URL_KEY, url); } catch { /* ignore */ }
        this.onStatusChange(true);
        // Send a keepalive ping every 25s to prevent proxy timeouts
        this.clearPing();
        this.pingTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 25_000);
      };

      this.ws.onmessage = (event) => {
        try {
          const msg: WsOutboundMessage = JSON.parse(event.data);
          this.onMessage(msg);
        } catch (err) {
          console.error('[WS] Failed to parse message:', err);
        }
      };

      this.ws.onclose = () => {
        if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
        this.clearPing();
        this.onStatusChange(false);
        this.urlIndex++; // next retry rolls over to the next candidate host
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        // onclose will fire after this
      };
    } catch {
      this.urlIndex++;
      this.scheduleReconnect();
    }
  }

  send(msg: WsInboundMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  destroy() {
    this.destroyed = true;
    this.clearPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
    }
    if (this.ws) {
      this.ws.close();
    }
  }

  private clearPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.destroyed) return;
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      this.connect();
    }, this.reconnectDelay);
  }
}
