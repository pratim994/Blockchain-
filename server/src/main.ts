// ============================================================
// server/src/main.ts
//
// Application entry point.  Wires together config, HTTP server,
// WebSocket server, and message handlers.
// ============================================================

import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config';
import { MessageBus }  from './websocket/message-bus';
import { registerHandlers } from './handlers/blockchain.handlers';
import { logger } from './logger';

async function main(): Promise<void> {
  const config = loadConfig();

  // ── HTTP layer (health check endpoint) ──────────────────────
  const app = express();
  app.use(express.json());

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', nodeId: config.nodeId, ts: Date.now() });
  });

  const httpServer = http.createServer(app);

  // ── WebSocket layer ──────────────────────────────────────────
  const wss = new WebSocketServer({
    server:    httpServer,
    maxPayload: config.ws.maxPayloadBytes,
  });

  const bus = new MessageBus(wss, config);
  registerHandlers(bus, config);

  // ── Start listening ──────────────────────────────────────────
  await new Promise<void>(resolve => httpServer.listen(config.port, resolve));
  logger.info(`Blockchain node started`, { nodeId: config.nodeId, port: config.port, env: config.nodeEnv });

  // ── Graceful shutdown ────────────────────────────────────────
  function shutdown(signal: string): void {
    logger.info(`Received ${signal} — shutting down gracefully.`);
    bus.shutdown();
    httpServer.close(() => {
      logger.info('HTTP server closed.');
      process.exit(0);
    });

    setTimeout(() => {
      logger.error('Forced exit after timeout.');
      process.exit(1);
    }, 10_000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

main().catch(err => {
  logger.error('Startup failed', { error: (err as Error).message });
  process.exit(1);
});
