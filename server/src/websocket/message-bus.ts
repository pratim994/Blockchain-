// ============================================================
// server/src/websocket/message-bus.ts
//
// Abstracts raw WebSocket I/O behind a typed message bus.
//
// Responsibilities:
//   • Connection lifecycle (open / close / error)
//   • Heartbeat / liveness (ping-pong)
//   • Dead-client cleanup
//   • Typed broadcast helpers
//   • Error-boundary: malformed frames never crash the process
// ============================================================

import WebSocket, { WebSocketServer } from 'ws';
import { generateUUID } from '../../../shared/src/utils';
import { logger } from '../logger';
import type { NetworkMessage, MessageType } from '../../../shared/src/types';
import type { ServerConfig } from '../config';

type MessageHandler = (ws: WebSocket, message: NetworkMessage) => void;

interface ExtendedWS extends WebSocket {
  isAlive: boolean;
  clientId: string;
}

export class MessageBus {
  private readonly handlers = new Map<MessageType, MessageHandler[]>();
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(
    private readonly wss: WebSocketServer,
    private readonly config: ServerConfig,
  ) {
    this.wss.on('connection', this.onConnection.bind(this));
    this.wss.on('error',      this.onServerError.bind(this));
    this.startHeartbeat();
  }

  // ── Public API ─────────────────────────────────────────────

  on(type: MessageType, handler: MessageHandler): void {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type)!.push(handler);
  }

  broadcast<P>(type: MessageType, payload: P, except?: WebSocket): void {
    const message = this.envelope(type, payload);
    const frame   = JSON.stringify(message);
    let sent = 0;

    this.liveClients().forEach(client => {
      if (client !== except) {
        client.send(frame);
        sent++;
      }
    });

    logger.debug('Broadcast', { type, recipientCount: sent });
  }

  send<P>(ws: WebSocket, type: MessageType, payload: P, correlationId?: string): void {
    const message = this.envelope(type, payload, correlationId);
    ws.send(JSON.stringify(message));
  }

  liveClients(): Set<ExtendedWS> {
    const alive = new Set<ExtendedWS>();
    (this.wss.clients as Set<ExtendedWS>).forEach(c => {
      if (c.isAlive && c.readyState === WebSocket.OPEN) alive.add(c);
    });
    return alive;
  }

  get clientCount(): number {
    return this.liveClients().size;
  }

  shutdown(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.wss.close();
  }

  // ── Private helpers ─────────────────────────────────────────

  private envelope<P>(type: MessageType, payload: P, correlationId?: string): NetworkMessage<P> {
    return {
      type,
      correlationId: correlationId ?? generateUUID(),
      senderId:      'server',
      timestamp:     Date.now(),
      payload,
    };
  }

  private onConnection(ws: WebSocket): void {
    const extWS = ws as ExtendedWS;
    extWS.isAlive  = true;
    extWS.clientId = generateUUID();

    logger.info('Client connected', { clientId: extWS.clientId, total: this.wss.clients.size });

    extWS.on('pong', () => { extWS.isAlive = true; });

    extWS.on('message', (raw: WebSocket.RawData) => {
      this.onRawMessage(extWS, raw);
    });

    extWS.on('close', (code, reason) => {
      logger.info('Client disconnected', {
        clientId: extWS.clientId,
        code,
        reason: reason.toString(),
        remaining: this.wss.clients.size - 1,
      });
    });

    extWS.on('error', (err) => {
      logger.error('Client socket error', { clientId: extWS.clientId, error: err.message });
    });
  }

  private onRawMessage(ws: ExtendedWS, raw: WebSocket.RawData): void {
    if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) {
      logger.warn('Unsupported frame type', { clientId: ws.clientId });
      return;
    }

    let message: NetworkMessage;
    try {
      message = JSON.parse(raw.toString());
    } catch (err) {
      logger.warn('Malformed JSON frame', { clientId: ws.clientId });
      return;
    }

    if (!message.type) {
      logger.warn('Message missing type field', { clientId: ws.clientId });
      return;
    }

    const handlers = this.handlers.get(message.type as MessageType) ?? [];
    if (handlers.length === 0) {
      logger.debug('No handler registered', { type: message.type });
      return;
    }

    for (const handler of handlers) {
      try {
        handler(ws, message);
      } catch (err) {
        logger.error('Handler threw', { type: message.type, error: (err as Error).message });
      }
    }
  }

  private onServerError(err: Error): void {
    logger.error('WebSocket server error', { error: err.message });
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      (this.wss.clients as Set<ExtendedWS>).forEach(ws => {
        if (!ws.isAlive) {
          logger.warn('Terminating unresponsive client', { clientId: ws.clientId });
          ws.terminate();
          return;
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, this.config.ws.pingIntervalMs);
  }
}
