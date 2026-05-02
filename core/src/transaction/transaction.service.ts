// ============================================================
// core/src/transaction/transaction.service.ts
//
// Domain logic for creating and validating transactions.
// Pure functions — no I/O, no side effects.
// ============================================================

import { generateUUID } from '../../../shared/src/utils';
import { signData, verifySignature } from '../crypto/ecdsa';
import type {
  Transaction,
  ValidationResult,
  PublicKey,
} from '../../../shared/src/types';

interface CreateTransactionInput {
  senderPublicKey: PublicKey;
  senderPrivateKey: string;
  recipient: PublicKey;
  amount: number;
}

/**
 * Construct and sign a new transaction.
 * The private key never leaves this function's scope after signing.
 */
export function createTransaction(input: CreateTransactionInput): Transaction {
  const { senderPublicKey, senderPrivateKey, recipient, amount } = input;

  if (amount <= 0) throw new RangeError('Transaction amount must be positive.');

  const id        = generateUUID();
  const timestamp = Date.now();

  // Sign the immutable transaction payload (excluding `signature` itself)
  const payload   = { id, sender: senderPublicKey, recipient, amount, timestamp };
  const signature = signData(payload, senderPrivateKey);

  return { id, sender: senderPublicKey, recipient, amount, timestamp, signature };
}

/**
 * Validate a transaction's structural integrity and cryptographic signature.
 *
 * Design decision: coinbase transactions (miner rewards) use a well-known
 * sentinel sender key 'COINBASE' and are exempt from signature checks.
 */
export function validateTransaction(tx: Transaction): ValidationResult {
  if (!tx.id || !tx.sender || !tx.recipient) {
    return { valid: false, reason: 'Transaction is missing required fields.' };
  }

  if (tx.amount <= 0) {
    return { valid: false, reason: `Invalid amount: ${tx.amount}` };
  }

  if (tx.timestamp > Date.now() + 60_000) {
    // Allow 60s clock skew
    return { valid: false, reason: 'Transaction timestamp is too far in the future.' };
  }

  if (tx.sender === 'COINBASE') return { valid: true }; // coinbase exempt

  const payload   = { id: tx.id, sender: tx.sender, recipient: tx.recipient, amount: tx.amount, timestamp: tx.timestamp };
  const sigValid  = verifySignature(payload, tx.signature, tx.sender);

  if (!sigValid) {
    return { valid: false, reason: 'Invalid ECDSA signature.' };
  }

  return { valid: true };
}

/**
 * Check for duplicate transaction IDs within a set of transactions.
 */
export function hasDuplicates(transactions: readonly Transaction[]): boolean {
  const ids = new Set(transactions.map(t => t.id));
  return ids.size !== transactions.length;
}
