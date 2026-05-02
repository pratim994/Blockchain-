// ============================================================
// server/src/__tests__/node-communication.test.ts
//
// Integration tests: spin up a real WS server, connect two
// client sockets, and assert protocol behavior.
// ============================================================

import http from 'http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { MessageBus } from '../websocket/message-bus';
import { registerHandlers } from '../handlers/blockchain.handlers';
import { MessageType } from '../../../shared/src/types';
import type { NetworkMessage } from '../../../shared/src/types';
import { generateUUID } from '../../../shared/src/utils';
import { loadConfig } from '../config';

const TEST_PORT = 4001;

// ── Test helpers ─────────────────────────────────────────────

function createMessage<P>(type: MessageType, payload: P): string {
  const msg: NetworkMessage<P> = {
    type,
    correlationId: generateUUID(),
    senderId:      'test-client',
    timestamp:     Date.now(),
    payload,
  };
  return JSON.stringify(msg);
}

function waitForMessage<P>(ws: WebSocket, type: MessageType): Promise<NetworkMessage<P>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 5_000);
    ws.on('message', (raw) => {
      const msg: NetworkMessage<P> = JSON.parse(raw.toString());
      if (msg.type === type) {
        clearTimeout(timer);
        resolve(msg);
      }
    });
  });
}

// ── Test suite ────────────────────────────────────────────────

describe('Node communication (integration)', () => {
  let server:     http.Server;
  let wss:        WebSocketServer;
  let bus:        MessageBus;
  let clientA:    WebSocket;
  let clientB:    WebSocket;

  beforeAll(async () => {
    process.env.PORT    = String(TEST_PORT);
    process.env.NODE_ID = 'test-node';

    const config = loadConfig();
    server = http.createServer();
    wss    = new WebSocketServer({ server });
    bus    = new MessageBus(wss, config);
    registerHandlers(bus, config);

    await new Promise<void>(resolve => server.listen(TEST_PORT, resolve));

    const connect = (ws: WebSocket) =>
      new Promise<void>(resolve => ws.once('open', resolve));

    clientA = new WebSocket(`ws://localhost:${TEST_PORT}`);
    clientB = new WebSocket(`ws://localhost:${TEST_PORT}`);

    await Promise.all([connect(clientA), connect(clientB)]);
    // Brief pause so the server registers both clients
    await new Promise(r => setTimeout(r, 100));
  });

  afterAll(done => {
    clientA.close();
    clientB.close();
    bus.shutdown();
    server.close(done);
  });

  // ──────────────────────────────────────────────────────────

  test('server reports 2 live clients', () => {
    expect(bus.clientCount).toBe(2);
  });

  test('GetLongestChainRequest triggers broadcast to peer', async () => {
    const responsePromise = waitForMessage<unknown>(clientB, MessageType.GET_LONGEST_CHAIN_REQUEST);
    clientA.send(createMessage(MessageType.GET_LONGEST_CHAIN_REQUEST, null));
    const relayed = await responsePromise;
    expect(relayed.type).toBe(MessageType.GET_LONGEST_CHAIN_REQUEST);
  });

  test('NewBlockAnnouncement is relayed to peer', async () => {
    const fakeBlock = {
      header: { index: 1, previousHash: '0'.repeat(64), timestamp: Date.now(), merkleRoot: '0'.repeat(64), nonce: 0, difficulty: 1 },
      transactions: [],
      hash: '0abc',
      minedBy: 'test',
    };

    const relayPromise = waitForMessage(clientB, MessageType.NEW_BLOCK_ANNOUNCEMENT);
    clientA.send(createMessage(MessageType.NEW_BLOCK_ANNOUNCEMENT, fakeBlock));

    const relayed = await relayPromise;
    expect(relayed.type).toBe(MessageType.NEW_BLOCK_ANNOUNCEMENT);
  });

  test('NewTransaction is gossipped to all peers', async () => {
    const fakeTx = {
      id: generateUUID(), sender: 'COINBASE', recipient: 'node-1',
      amount: 50, timestamp: Date.now(), signature: '',
    };

    const gossipPromise = waitForMessage(clientB, MessageType.NEW_TRANSACTION);
    clientA.send(createMessage(MessageType.NEW_TRANSACTION, fakeTx));

    const gossiped = await gossipPromise;
    expect(gossiped.type).toBe(MessageType.NEW_TRANSACTION);
  });
});
