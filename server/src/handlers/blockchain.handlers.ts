// ============================================================
// server/src/handlers/blockchain.handlers.ts
//
// Event handlers wired to the MessageBus.
// Each handler is a pure coordinator: read from bus, mutate
// server state (chain + pending), respond/broadcast.
//
// Design: handlers hold NO blockchain state themselves — that
// lives in BlockchainServerState below (single source of truth).
// ============================================================

import WebSocket from 'ws';
import { MessageBus } from '../websocket/message-bus';
import { logger } from '../logger';
import {
  createBlockchain,
  addBlockToChain,
  addPendingTransaction,
  buildBlockCandidate,
  validateChain,
} from '../../../core/src/chain/blockchain.engine';
import { mineBlock } from '../../../core/src/pow/proof-of-work';
import { validateTransaction } from '../../../core/src/transaction/transaction.service';
import { MessageType } from '../../../shared/src/types';
import type {
  Block,
  Blockchain,
  Transaction,
  NetworkMessage,
  BlockchainConfig,
} from '../../../shared/src/types';
import type { ServerConfig } from '../config';

// ── Shared mutable state (scoped to module) ──────────────────
// In a real multi-process deployment this would be Redis / a
// distributed state store. For a single-process simulation it
// lives here, protected by the single-threaded Node.js event loop.

interface ServerState {
  chain:      Blockchain;
  isMining:   boolean;
  miningAbort: AbortController | null;
}

// ── Pending GetLongestChain negotiations ─────────────────────

interface PendingRequest {
  requestor: WebSocket;
  replies:   Map<WebSocket, Block[]>;
}

export function registerHandlers(bus: MessageBus, config: ServerConfig): void {
  const state: ServerState = {
    chain:       createBlockchain(config.nodeId, config.blockchain),
    isMining:    false,
    miningAbort: null,
  };

  // Map<correlationId, PendingRequest>
  const pendingChainRequests = new Map<string, PendingRequest>();

  // ── GetLongestChain ────────────────────────────────────────

  bus.on(MessageType.GET_LONGEST_CHAIN_REQUEST, (ws, msg) => {
    logger.info('GetLongestChainRequest received', { correlationId: msg.correlationId });

    if (bus.clientCount <= 1) {
      // Only the requestor is connected — send empty chain (genesis will be created client-side)
      bus.send(ws, MessageType.GET_LONGEST_CHAIN_RESPONSE, [], msg.correlationId);
      return;
    }

    pendingChainRequests.set(msg.correlationId, {
      requestor: ws,
      replies:   new Map(),
    });

    bus.broadcast(MessageType.GET_LONGEST_CHAIN_REQUEST, msg.payload, ws);
  });

  bus.on(MessageType.GET_LONGEST_CHAIN_RESPONSE, (ws, msg) => {
    const pending = pendingChainRequests.get(msg.correlationId);
    if (!pending) return;

    pending.replies.set(ws, msg.payload as Block[]);

    const expectedReplies = bus.clientCount - 1; // all except requestor
    if (pending.replies.size >= expectedReplies) {
      const longestChain = selectLongestValidChain([...pending.replies.values()]);
      bus.send(pending.requestor, MessageType.GET_LONGEST_CHAIN_RESPONSE, longestChain, msg.correlationId);
      pendingChainRequests.delete(msg.correlationId);
    }
  });

  // ── NewBlockRequest (client wants to mine) ─────────────────

  bus.on(MessageType.NEW_BLOCK_REQUEST, async (ws, msg) => {
    const transactions = msg.payload as Transaction[];

    // Validate all submitted transactions before accepting the request
    for (const tx of transactions) {
      const result = validateTransaction(tx);
      if (!result.valid) {
        logger.warn('Rejected transaction in block request', { txId: tx.id, reason: result.reason });
        bus.send(ws, MessageType.BLOCK_REJECTED, { reason: result.reason }, msg.correlationId);
        return;
      }
    }

    // Broadcast to all other nodes so they can also mine
    bus.broadcast(MessageType.NEW_BLOCK_REQUEST, transactions, ws);

    // Mine server-side as well (simulates this node also mining)
    if (!state.isMining) {
      mineServerBlock(state, transactions, bus, config.blockchain);
    }
  });

  // ── NewBlockAnnouncement (broadcast to all peers) ──────────

  bus.on(MessageType.NEW_BLOCK_ANNOUNCEMENT, (ws, msg) => {
    const block = msg.payload as Block;
    logger.info('NewBlockAnnouncement', { index: block.header.index, hash: block.hash.slice(0, 16) });

    // Abort any in-flight mining at this index — peer already won
    if (state.isMining && state.chain.blocks.length === block.header.index) {
      state.miningAbort?.abort();
    }

    try {
      state.chain = addBlockToChain(state.chain, block, config.blockchain);
      bus.broadcast(MessageType.NEW_BLOCK_ANNOUNCEMENT, block, ws);
    } catch (err) {
      logger.warn('Rejected announced block', { error: (err as Error).message });
    }
  });

  // ── NewTransaction (gossip protocol) ──────────────────────

  bus.on(MessageType.NEW_TRANSACTION, (ws, msg) => {
    const tx = msg.payload as Transaction;
    const result = validateTransaction(tx);
    if (!result.valid) return;

    try {
      state.chain = addPendingTransaction(state.chain, tx);
      bus.broadcast(MessageType.NEW_TRANSACTION, tx, ws);
    } catch { /* duplicate or invalid — silently drop */ }
  });
}

// ── Helper: mine a block server-side ─────────────────────────

async function mineServerBlock(
  state: ServerState,
  transactions: readonly Transaction[],
  bus: MessageBus,
  config: BlockchainConfig
): Promise<void> {
  state.isMining    = true;
  state.miningAbort = new AbortController();

  try {
    const candidate = buildBlockCandidate(state.chain, transactions, config);
    const result    = await mineBlock(candidate.header, state.chain.difficulty, state.miningAbort.signal);

    if (!result) {
      logger.info('Mining aborted (longer chain received)');
      return;
    }

    const newBlock: Block = {
      ...candidate,
      header: { ...candidate.header, nonce: result.nonce, difficulty: state.chain.difficulty },
      hash:   result.hash,
    };

    state.chain = addBlockToChain(state.chain, newBlock, config);
    bus.broadcast(MessageType.NEW_BLOCK_ANNOUNCEMENT, newBlock);

    logger.info('Block mined', { index: newBlock.header.index, hash: newBlock.hash.slice(0, 16), nonce: result.nonce });
  } catch (err) {
    logger.error('Mining failed', { error: (err as Error).message });
  } finally {
    state.isMining    = false;
    state.miningAbort = null;
  }
}

// ── Helper: pick the longest valid chain from peer responses ─

function selectLongestValidChain(chains: Block[][]): Block[] {
  return chains
    .filter(chain => validateChain(chain).valid)
    .reduce<Block[]>((longest, current) =>
      current.length > longest.length ? current : longest
    , []);
}
