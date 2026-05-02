// ============================================================
// core/src/pow/proof-of-work.ts
//
// Hashcash-style proof-of-work.  The miner increments a nonce
// until SHA-256(header) has `difficulty` leading zeros.
//
// Cancellation is supported via an AbortSignal so mining can
// be interrupted when a peer announces a longer chain.
// ============================================================

import { sha256 } from '../../../shared/src/utils';
import type { BlockHeader, Hash } from '../../../shared/src/types';

export interface MiningResult {
  nonce: number;
  hash:  Hash;
}

/**
 * Canonical serialization of a BlockHeader.
 * JSON.stringify is key-order dependent — this guarantees mineBlock
 * and validateChain always hash the exact same byte sequence.
 */
export function canonicalHeader(header: BlockHeader): string {
  return JSON.stringify({
    index:        header.index,
    previousHash: header.previousHash,
    timestamp:    header.timestamp,
    merkleRoot:   header.merkleRoot,
    difficulty:   header.difficulty,
    nonce:        header.nonce,
  });
}

export function hashHeader(header: BlockHeader): Hash {
  return sha256(canonicalHeader(header));
}

/**
 * Satisfy the proof-of-work requirement for `header`.
 * Returns null if the AbortSignal fires before a solution is found.
 */
export async function mineBlock(
  header: Omit<BlockHeader, 'nonce'>,
  difficulty: number,
  signal?: AbortSignal
): Promise<MiningResult | null> {
  const prefix = '0'.repeat(difficulty);
  let nonce = 0;

  while (true) {
    if (signal?.aborted) return null;

    const fullHeader: BlockHeader = {
      index:        header.index,
      previousHash: header.previousHash,
      timestamp:    header.timestamp,
      merkleRoot:   header.merkleRoot,
      difficulty:   header.difficulty,
      nonce,
    };
    const hash = hashHeader(fullHeader);

    if (hash.startsWith(prefix)) {
      return { nonce, hash };
    }

    nonce++;

    if (nonce % 10_000 === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }
}

/**
 * Verify that a block hash satisfies the difficulty requirement.
 * Called during chain validation — no I/O, pure computation.
 */
export function verifyProofOfWork(hash: Hash, difficulty: number): boolean {
  return hash.startsWith('0'.repeat(difficulty));
}

/**
 * Dynamic difficulty retargeting (simplified Bitcoin-style).
 * If recent blocks are coming in faster than target, increase difficulty; 
 * if slower, decrease. Clamped to [1, 8].
 */
export function retargetDifficulty(
  currentDifficulty: number,
  actualBlockTimeMs: number,
  targetBlockTimeMs: number
): number {
  const ratio = actualBlockTimeMs / targetBlockTimeMs;
  if (ratio < 0.5)  return Math.min(currentDifficulty + 1, 8);
  if (ratio > 2.0)  return Math.max(currentDifficulty - 1, 1);
  return currentDifficulty;
}