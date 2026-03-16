import type { WsInboundMessage, WsOutboundMessage } from '@clauder/shared';

export type WsMessageHandler = (msg: WsOutboundMessage) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private onMessage: WsMessageHandler;
  private onStatusChange: (connected: boolean) => void;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private destroyed = false;

  constructor(
    url: string,
    onMessage: WsMessageHandler,
    onStatusChange: (connected: boolean) => void,
  ) {
    this.url = url;
    this.onMessage = onMessage;
    this.onStatusChange = onStatusChange;
  }

  connect() {
    if (this.destroyed) return;

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.reconnectDelay = 1000;
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
        this.clearPing();
        this.onStatusChange(false);
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        // onclose will fire after this
      };
    } catch {
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
