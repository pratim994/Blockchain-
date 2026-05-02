// ============================================================
// core/src/chain/blockchain.engine.ts
//
// Pure blockchain domain logic.  No WebSockets, no Express,
// no React — just data transformations and validations.
//
// This is the testable "core" of the clean-architecture onion.
// ============================================================

import { sha256, computeMerkleRoot, generateUUID } from '../../../shared/src/utils';
import { validateTransaction, hasDuplicates } from '../transaction/transaction.service';
import { verifyProofOfWork, mineBlock, retargetDifficulty } from '../pow/proof-of-work';
import type {
  Block,
  BlockHeader,
  Transaction,
  Blockchain,
  ValidationResult,
  BlockchainConfig,
  Hash,
} from '../../../shared/src/types';
import { DEFAULT_CONFIG } from '../../../shared/src/types';

// ── Genesis block (hard-coded constant) ─────────────────────

const GENESIS_PREVIOUS_HASH: Hash = '0'.repeat(64);

export function createGenesisBlock(nodeId: string, config: BlockchainConfig): Block {
  const header: BlockHeader = {
    index:        0,
    previousHash: GENESIS_PREVIOUS_HASH,
    timestamp:    0,
    merkleRoot:   '0'.repeat(64),
    nonce:        0,
    difficulty:   config.difficulty,
  };

  return {
    header,
    transactions: [],
    hash:         sha256(header),
    minedBy:      nodeId,
  };
}

// ── Chain construction ───────────────────────────────────────

export function createBlockchain(
  nodeId: string,
  config: BlockchainConfig = DEFAULT_CONFIG
): Blockchain {
  return {
    blocks:               [createGenesisBlock(nodeId, config)],
    pendingTransactions:  [],
    difficulty:           config.difficulty,
    nodeId,
  };
}

// ── Block creation (before PoW) ──────────────────────────────

export interface BlockCandidate {
  header:       Omit<BlockHeader, 'nonce'>;
  transactions: Transaction[];
  minedBy:      string;
}

export function buildBlockCandidate(
  chain: Blockchain,
  transactions: readonly Transaction[],
  config: BlockchainConfig
): BlockCandidate {
  const previousBlock = chain.blocks[chain.blocks.length - 1];

  const coinbase: Transaction = {
    id:        generateUUID(),
    sender:    'COINBASE',
    recipient: chain.nodeId,
    amount:    config.blockReward,
    timestamp: Date.now(),
    signature: '',
  };

  const allTransactions = [coinbase, ...transactions];
  const merkleRoot      = computeMerkleRoot(allTransactions);

  const header: Omit<BlockHeader, 'nonce'> = {
    index:        previousBlock.header.index + 1,
    previousHash: previousBlock.hash,
    timestamp:    Date.now(),
    merkleRoot,
    difficulty:   chain.difficulty,
  };

  return { header, transactions: allTransactions, minedBy: chain.nodeId };
}

// ── Chain validation ─────────────────────────────────────────

export function validateChain(blocks: readonly Block[]): ValidationResult {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    // 1. Hash integrity
    const recomputedHash = sha256(block.header);
    if (recomputedHash !== block.hash) {
      return { valid: false, reason: `Block #${i}: hash mismatch (data tampered).` };
    }

    // 2. Proof-of-work
    if (!verifyProofOfWork(block.hash, block.header.difficulty)) {
      return { valid: false, reason: `Block #${i}: proof-of-work not satisfied.` };
    }

    // 3. Chain linkage (skip genesis)
    if (i > 0) {
      const previousBlock = blocks[i - 1];
      if (block.header.previousHash !== previousBlock.hash) {
        return { valid: false, reason: `Block #${i}: previousHash does not match block #${i - 1}.` };
      }
      if (block.header.index !== previousBlock.header.index + 1) {
        return { valid: false, reason: `Block #${i}: index is not sequential.` };
      }
    }

    // 4. Transaction validation
    if (hasDuplicates(block.transactions)) {
      return { valid: false, reason: `Block #${i}: contains duplicate transactions.` };
    }

    for (const tx of block.transactions) {
      const txResult = validateTransaction(tx);
      if (!txResult.valid) {
        return { valid: false, reason: `Block #${i}, tx ${tx.id}: ${(txResult as { valid: false; reason: string }).reason}` };
      }
    }

    // 5. Merkle root
    const expectedMerkle = computeMerkleRoot(block.transactions);
    if (expectedMerkle !== block.header.merkleRoot) {
      return { valid: false, reason: `Block #${i}: merkle root mismatch.` };
    }
  }

  return { valid: true };
}

// ── Chain replacement (Nakamoto consensus) ───────────────────

/**
 * Replace the local chain with a longer valid chain from a peer.
 * Returns the winning chain.
 *
 * Design decision: we use "longest valid chain wins" (Nakamoto consensus)
 * rather than "most work done" for simplicity; in production you'd compare
 * cumulative difficulty.
 */
export function resolveChainConflict(
  localChain:  readonly Block[],
  remoteChain: readonly Block[]
): { resolved: readonly Block[]; replaced: boolean } {
  if (remoteChain.length <= localChain.length) {
    return { resolved: localChain, replaced: false };
  }

  const validation = validateChain(remoteChain);
  if (!validation.valid) {
    return { resolved: localChain, replaced: false };
  }

  return { resolved: remoteChain, replaced: true };
}

// ── Immutable state updates ──────────────────────────────────

export function addBlockToChain(
  chain: Blockchain,
  block: Block,
  config: BlockchainConfig
): Blockchain {
  const { resolved, replaced } = resolveChainConflict(chain.blocks, [...chain.blocks, block]);

  if (!replaced && chain.blocks[chain.blocks.length - 1].hash !== block.header.previousHash) {
    throw new Error('Block does not extend the current chain tip.');
  }

  // Remove transactions already included in this block
  const includedIds = new Set(block.transactions.map(tx => tx.id));
  const pendingTransactions = chain.pendingTransactions.filter(tx => !includedIds.has(tx.id));

  // Dynamic difficulty retargeting
  let difficulty = chain.difficulty;
  if (block.header.index > 0 && block.header.index % config.difficultyRetargetInterval === 0) {
    const windowStart = resolved[Math.max(0, resolved.length - config.difficultyRetargetInterval)];
    const actualTimeMs = block.header.timestamp - windowStart.header.timestamp;
    difficulty = retargetDifficulty(chain.difficulty, actualTimeMs, config.targetBlockTimeMs);
  }

  return {
    ...chain,
    blocks: [...chain.blocks, block],
    pendingTransactions,
    difficulty,
  };
}

export function addPendingTransaction(
  chain: Blockchain,
  tx: Transaction
): Blockchain {
  const validation = validateTransaction(tx);
  if (!validation.valid) throw new Error((validation as { valid: false; reason: string }).reason);
  return { ...chain, pendingTransactions: [...chain.pendingTransactions, tx] };
}