// ============================================================
// shared/src/types/index.ts
// Single source of truth for all cross-module types.
// ============================================================

export type UUID = string;
export type Hash = string;
export type PublicKey = string;
export type Signature = string;

// ── Blockchain primitives ────────────────────────────────────

export interface Transaction {
  readonly id: UUID;
  readonly sender: PublicKey;   // ECDSA public key (hex)
  readonly recipient: PublicKey;
  readonly amount: number;
  readonly timestamp: number;
  readonly signature: Signature; // ECDSA signature of (id+sender+recipient+amount+timestamp)
}

export interface BlockHeader {
  readonly index: number;
  readonly previousHash: Hash;
  readonly timestamp: number;
  readonly merkleRoot: Hash;
  readonly nonce: number;
  readonly difficulty: number;
}

export interface Block {
  readonly header: BlockHeader;
  readonly transactions: readonly Transaction[];
  readonly hash: Hash;          // SHA-256(header)
  readonly minedBy: string;     // node ID that mined this block
}

export interface Blockchain {
  readonly blocks: readonly Block[];
  readonly pendingTransactions: readonly Transaction[];
  readonly difficulty: number;
  readonly nodeId: string;
}

// ── Network / P2P ────────────────────────────────────────────

export enum MessageType {
  // Chain sync
  GET_LONGEST_CHAIN_REQUEST  = 'GET_LONGEST_CHAIN_REQUEST',
  GET_LONGEST_CHAIN_RESPONSE = 'GET_LONGEST_CHAIN_RESPONSE',
  CHAIN_SYNC_REQUEST         = 'CHAIN_SYNC_REQUEST',
  CHAIN_SYNC_RESPONSE        = 'CHAIN_SYNC_RESPONSE',

  // Block lifecycle
  NEW_BLOCK_REQUEST          = 'NEW_BLOCK_REQUEST',
  NEW_BLOCK_ANNOUNCEMENT     = 'NEW_BLOCK_ANNOUNCEMENT',
  BLOCK_REJECTED             = 'BLOCK_REJECTED',

  // Transactions
  NEW_TRANSACTION            = 'NEW_TRANSACTION',

  // Node management
  NODE_CONNECTED             = 'NODE_CONNECTED',
  NODE_DISCONNECTED          = 'NODE_DISCONNECTED',
  PING                       = 'PING',
  PONG                       = 'PONG',
}

export interface NetworkMessage<P = unknown> {
  readonly type: MessageType;
  readonly correlationId: UUID;
  readonly senderId: string;
  readonly timestamp: number;
  readonly payload: P;
}

export interface NodeInfo {
  readonly id: string;
  readonly address: string;
  readonly chainLength: number;
  readonly isConnected: boolean;
  readonly lastSeen: number;
}

// ── Validation results ───────────────────────────────────────

export type ValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

// ── Config ───────────────────────────────────────────────────

export interface BlockchainConfig {
  readonly difficulty: number;           // leading zeros required in hash
  readonly maxBlockTransactions: number;
  readonly blockReward: number;
  readonly targetBlockTimeMs: number;    // for difficulty retargeting
  readonly difficultyRetargetInterval: number; // blocks between retargets
}

export const DEFAULT_CONFIG: BlockchainConfig = {
  difficulty: 3,
  maxBlockTransactions: 10,
  blockReward: 50,
  targetBlockTimeMs: 5_000,
  difficultyRetargetInterval: 10,
};
