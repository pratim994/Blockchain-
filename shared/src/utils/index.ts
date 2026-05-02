// ============================================================
// shared/src/utils/index.ts
// ============================================================

import { createHash, randomBytes } from 'crypto';
import type { Hash, Transaction } from '../types';

export function generateUUID(): string {
  return randomBytes(16).toString('hex');
}

/**
 * SHA-256 over an arbitrary object (deterministic JSON serialization).
 */
export function sha256(data: unknown): Hash {
  return createHash('sha256')
    .update(JSON.stringify(data))
    .digest('hex');
}

/**
 * Compute the Merkle root of an ordered list of transactions.
 * Returns '0'.repeat(64) for an empty list (genesis).
 */
export function computeMerkleRoot(transactions: readonly Transaction[]): Hash {
  if (transactions.length === 0) return '0'.repeat(64);

  let hashes: Hash[] = transactions.map(tx =>
    sha256({ id: tx.id, sender: tx.sender, recipient: tx.recipient, amount: tx.amount, timestamp: tx.timestamp })
  );

  while (hashes.length > 1) {
    const next: Hash[] = [];
    for (let i = 0; i < hashes.length; i += 2) {
      const left = hashes[i];
      const right = hashes[i + 1] ?? hashes[i]; // duplicate last if odd
      next.push(sha256(left + right));
    }
    hashes = next;
  }

  return hashes[0];
}

/**
 * Type-safe sleep helper.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Clamp a number between min and max.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
