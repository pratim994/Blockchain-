// ============================================================
// client/src/store/blockchain.store.ts
//
// Zustand store.  All blockchain state lives here; components
// are pure consumers.  Async operations (mining, WS connection)
// are modeled as explicit status fields so the UI can reflect
// every transition.
// ============================================================

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { WebSocketClient } from '../lib/websocket.client';
import {
  createBlockchain,
  addBlockToChain,
  addPendingTransaction,
  buildBlockCandidate,
} from '../../../core/src/chain/blockchain.engine';
import { mineBlock } from '../../../core/src/pow/proof-of-work';
import { createTransaction } from '../../../core/src/transaction/transaction.service';
import { generateKeyPair } from '../../../core/src/crypto/ecdsa';
import { MessageType, DEFAULT_CONFIG } from '../../../shared/src/types';
import type {
  Block,
  Transaction,
  Blockchain,
  NetworkMessage,
  NodeInfo,
} from '../../../shared/src/types';

// ── Types ────────────────────────────────────────────────────

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
type MiningStatus     = 'idle' | 'mining' | 'success' | 'aborted';

interface KeyPairState {
  publicKey:  string;
  privateKey: string;
}

interface BlockchainStore {
  // State
  chain:            Blockchain | null;
  nodes:            NodeInfo[];
  connectionStatus: ConnectionStatus;
  miningStatus:     MiningStatus;
  lastError:        string | null;
  keyPair:          KeyPairState;
  miningAbort:      AbortController | null;

  // Actions
  initialize:          () => Promise<void>;
  disconnect:          () => void;
  submitTransaction:   (recipient: string, amount: number) => Promise<void>;
  mineBlock:           () => Promise<void>;
  generateNewKeyPair:  () => void;
}

const WS_URL = process.env.REACT_APP_WS_URL ?? 'ws://localhost:3000';
const NODE_ID = `browser-${Math.random().toString(36).slice(2, 8)}`;

const wsClient = new WebSocketClient(WS_URL);

// ── Store ─────────────────────────────────────────────────────

export const useBlockchainStore = create<BlockchainStore>()(
  devtools(
    (set, get) => ({
      chain:            null,
      nodes:            [],
      connectionStatus: 'disconnected',
      miningStatus:     'idle',
      lastError:        null,
      keyPair:          generateKeyPair(),
      miningAbort:      null,

      // ── initialize ───────────────────────────────────────

      initialize: async () => {
        set({ connectionStatus: 'connecting', lastError: null });

        try {
          await wsClient.connect(handleIncomingMessage(set, get));

          const remoteChain = await wsClient.requestLongestChain();
          const chain = createBlockchain(NODE_ID, DEFAULT_CONFIG);

          if (remoteChain.length > 0) {
            // Bootstrap from the network's longest chain
            let synced = chain;
            for (const block of remoteChain) {
              try { synced = addBlockToChain(synced, block, DEFAULT_CONFIG); } catch { /* skip invalid */ }
            }
            set({ chain: synced, connectionStatus: 'connected' });
          } else {
            set({ chain, connectionStatus: 'connected' });
          }
        } catch (err) {
          set({ connectionStatus: 'error', lastError: (err as Error).message });
        }
      },

      // ── disconnect ───────────────────────────────────────

      disconnect: () => {
        wsClient.disconnect();
        set({ connectionStatus: 'disconnected' });
      },

      // ── submitTransaction ────────────────────────────────

      submitTransaction: async (recipient, amount) => {
        const { chain, keyPair } = get();
        if (!chain) return;

        try {
          const tx = createTransaction({
            senderPublicKey:  keyPair.publicKey,
            senderPrivateKey: keyPair.privateKey,
            recipient,
            amount,
          });

          const updated = addPendingTransaction(chain, tx);
          set({ chain: updated });

          wsClient.send(MessageType.NEW_TRANSACTION, tx);
        } catch (err) {
          set({ lastError: (err as Error).message });
        }
      },

      // ── mineBlock ────────────────────────────────────────

      mineBlock: async () => {
        const { chain } = get();
        if (!chain || chain.pendingTransactions.length === 0) return;

        const abort = new AbortController();
        set({ miningStatus: 'mining', miningAbort: abort });

        // Notify peers
        wsClient.send(MessageType.NEW_BLOCK_REQUEST, chain.pendingTransactions);

        try {
          const candidate = buildBlockCandidate(chain, chain.pendingTransactions, DEFAULT_CONFIG);
          const result    = await mineBlock(candidate.header, chain.difficulty, abort.signal);

          if (!result) {
            set({ miningStatus: 'aborted' });
            return;
          }

          const newBlock: Block = {
            ...candidate,
            header: { ...candidate.header, nonce: result.nonce, difficulty: chain.difficulty },
            hash:   result.hash,
          };

          const updated = addBlockToChain(chain, newBlock, DEFAULT_CONFIG);
          set({ chain: updated, miningStatus: 'success' });

          wsClient.send(MessageType.NEW_BLOCK_ANNOUNCEMENT, newBlock);
        } catch (err) {
          set({ miningStatus: 'idle', lastError: (err as Error).message });
        } finally {
          set({ miningAbort: null });
        }
      },

      // ── generateNewKeyPair ───────────────────────────────

      generateNewKeyPair: () => set({ keyPair: generateKeyPair() }),
    }),
    { name: 'blockchain-store' }
  )
);

// ── Incoming message handler (pure function, no store deps) ──

function handleIncomingMessage(
  set: (partial: Partial<BlockchainStore>) => void,
  get: () => BlockchainStore,
) {
  return (message: NetworkMessage): void => {
    const { chain, miningAbort } = get();

    switch (message.type) {
      case MessageType.NEW_BLOCK_ANNOUNCEMENT: {
        if (!chain) return;
        const block = message.payload as Block;

        // Abort mining if a peer found the same-height block first
        if (chain.blocks.length === block.header.index) {
          miningAbort?.abort();
        }

        try {
          const updated = addBlockToChain(chain, block, DEFAULT_CONFIG);
          set({ chain: updated });
        } catch { /* peer announced an invalid block — ignore */ }
        break;
      }

      case MessageType.GET_LONGEST_CHAIN_REQUEST: {
        if (!chain) return;
        wsClient.send(MessageType.GET_LONGEST_CHAIN_RESPONSE, chain.blocks, message.correlationId);
        break;
      }

      case MessageType.NEW_TRANSACTION: {
        if (!chain) return;
        try {
          const tx      = message.payload as Transaction;
          const updated = addPendingTransaction(chain, tx);
          set({ chain: updated });
        } catch { /* duplicate or invalid */ }
        break;
      }

      case MessageType.NODE_CONNECTED:
      case MessageType.NODE_DISCONNECTED: {
        // In a production app, update the nodes panel
        break;
      }

      default:
        console.debug(`[Store] Unhandled message type: ${message.type}`);
    }
  };
}
