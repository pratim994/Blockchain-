// ============================================================
// client/src/lib/websocket.client.ts
//
// Resilient WebSocket client with:
//   • Exponential back-off reconnection
//   • Promise-based request / response correlation
//   • Typed message dispatch
// ============================================================

import { generateUUID } from '../../../shared/src/utils';
import type { MessageType, NetworkMessage, Block } from '../../../shared/src/types';
import { MessageType as MT } from '../../../shared/src/types';

type RawHandler = (message: NetworkMessage) => void;

interface PendingPromise<T> {
  resolve: (value: T) => void;
  reject:  (reason: Error) => void;
  timer:   ReturnType<typeof setTimeout>;
}

const BACKOFF_BASE_MS     = 500;
const BACKOFF_MAX_MS      = 30_000;
const REQUEST_TIMEOUT_MS  = 10_000;

export class WebSocketClient {
  private ws:            WebSocket | null = null;
  private handlers       = new Map<MessageType, RawHandler[]>();
  private pending        = new Map<string, PendingPromise<unknown>>();
  private reconnectDelay = BACKOFF_BASE_MS;
  private intentionalClose = false;

  constructor(private readonly url: string) {}

  // ── Public API ───────────────────────────────────────────

  connect(onMessage: (msg: NetworkMessage) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.reconnectDelay = BACKOFF_BASE_MS;
        resolve();
      };

      this.ws.onerror = (e) => reject(new Error(`WS connection error: ${JSON.stringify(e)}`));

      this.ws.onmessage = (event: MessageEvent<string>) => {
        try {
          const message: NetworkMessage = JSON.parse(event.data);

          // Resolve pending request/response pairs
          if (this.pending.has(message.correlationId)) {
            const p = this.pending.get(message.correlationId)!;
            clearTimeout(p.timer);
            this.pending.delete(message.correlationId);
            (p.resolve as (v: unknown) => void)(message.payload);
            return;
          }

          onMessage(message);
        } catch { /* malformed frame */ }
      };

      this.ws.onclose = () => {
        if (!this.intentionalClose) this.scheduleReconnect(onMessage);
      };
    });
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.ws?.close();
  }

  send<P>(type: MessageType, payload: P, correlationId?: string): void {
    const message: NetworkMessage<P> = {
      type,
      correlationId: correlationId ?? generateUUID(),
      senderId:      'client',
      timestamp:     Date.now(),
      payload,
    };
    this.ws?.send(JSON.stringify(message));
  }

  /**
   * Send a request and wait for the correlated response.
   */
  request<Req, Res>(type: MessageType, payload: Req): Promise<Res> {
    return new Promise<Res>((resolve, reject) => {
      const correlationId = generateUUID();
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(new Error(`Request ${type} timed out.`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(correlationId, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      this.send(type, payload, correlationId);
    });
  }

  // ── Convenience request helpers ──────────────────────────

  requestLongestChain(): Promise<Block[]> {
    return this.request<null, Block[]>(MT.GET_LONGEST_CHAIN_REQUEST, null);
  }

  // ── Private ─────────────────────────────────────────────

  private scheduleReconnect(onMessage: (msg: NetworkMessage) => void): void {
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, BACKOFF_MAX_MS);
    console.warn(`[WS] Reconnecting in ${delay}ms…`);
    setTimeout(() => this.connect(onMessage), delay);
  }
}
