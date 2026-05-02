// ============================================================
// core/src/__tests__/blockchain.engine.test.ts
//
// Unit tests for pure blockchain domain logic.
// Zero I/O — these run in milliseconds.
// ============================================================

import {
  createBlockchain,
  addBlockToChain,
  addPendingTransaction,
  validateChain,
  resolveChainConflict,
  createGenesisBlock,
  buildBlockCandidate,
} from '../chain/blockchain.engine';
import { mineBlock } from '../pow/proof-of-work';
import { createTransaction, validateTransaction } from '../transaction/transaction.service';
import { generateKeyPair } from '../crypto/ecdsa';
import { DEFAULT_CONFIG } from '../../../shared/src/types';
import type { Block, BlockchainConfig, Transaction } from '../../../shared/src/types';
import { sha256 } from '../../../shared/src/utils';

const TEST_CONFIG: BlockchainConfig = {
  ...DEFAULT_CONFIG,
  difficulty: 1, // difficulty 1 for fast tests
};

// ── Helpers ──────────────────────────────────────────────────

async function mineTestBlock(chain: ReturnType<typeof createBlockchain>, txs: Transaction[] = []): Promise<Block> {
  const candidate = buildBlockCandidate(chain, txs, TEST_CONFIG);
  const result    = await mineBlock(candidate.header, TEST_CONFIG.difficulty);
  if (!result) throw new Error('Mining failed in test');
  return {
    ...candidate,
    header: { ...candidate.header, nonce: result.nonce, difficulty: TEST_CONFIG.difficulty },
    hash:   result.hash,
  };
}

// ── Tests: Transaction ───────────────────────────────────────

describe('Transaction', () => {
  const { publicKey, privateKey } = generateKeyPair();
  const { publicKey: recipientKey } = generateKeyPair();

  test('creates a valid signed transaction', () => {
    const tx = createTransaction({
      senderPublicKey:  publicKey,
      senderPrivateKey: privateKey,
      recipient:        recipientKey,
      amount:           10,
    });

    expect(tx.sender).toBe(publicKey);
    expect(tx.amount).toBe(10);
    expect(tx.signature).toBeTruthy();
  });

  test('validates a correctly signed transaction', () => {
    const tx = createTransaction({
      senderPublicKey:  publicKey,
      senderPrivateKey: privateKey,
      recipient:        recipientKey,
      amount:           5,
    });

    const result = validateTransaction(tx);
    expect(result.valid).toBe(true);
  });

  test('rejects a transaction with tampered amount', () => {
    const tx = createTransaction({
      senderPublicKey:  publicKey,
      senderPrivateKey: privateKey,
      recipient:        recipientKey,
      amount:           5,
    });

    // Tamper with the amount after signing
    const tampered = { ...tx, amount: 9999 };
    const result   = validateTransaction(tampered);
    expect(result.valid).toBe(false);
  });

  test('rejects a transaction with zero amount', () => {
    expect(() =>
      createTransaction({ senderPublicKey: publicKey, senderPrivateKey: privateKey, recipient: recipientKey, amount: 0 })
    ).toThrow(RangeError);
  });

  test('accepts coinbase transactions without signature', () => {
    const coinbase: Transaction = {
      id: '1', sender: 'COINBASE', recipient: publicKey,
      amount: 50, timestamp: Date.now(), signature: '',
    };
    expect(validateTransaction(coinbase).valid).toBe(true);
  });
});

// ── Tests: Chain creation ────────────────────────────────────

describe('Blockchain creation', () => {
  test('creates chain with genesis block', () => {
    const chain = createBlockchain('node-1', TEST_CONFIG);
    expect(chain.blocks).toHaveLength(1);
    expect(chain.blocks[0].header.index).toBe(0);
    expect(chain.blocks[0].header.previousHash).toBe('0'.repeat(64));
  });

  test('genesis block hash is reproducible', () => {
    const genesis1 = createGenesisBlock('node-1', TEST_CONFIG);
    const genesis2 = createGenesisBlock('node-1', TEST_CONFIG);
    expect(genesis1.hash).toBe(genesis2.hash);
  });
});

// ── Tests: Mining & PoW ───────────────────────────────────────

describe('Proof of Work', () => {
  test('mined block hash satisfies difficulty', async () => {
    const chain = createBlockchain('node-1', TEST_CONFIG);
    const block = await mineTestBlock(chain);
    expect(block.hash.startsWith('0'.repeat(TEST_CONFIG.difficulty))).toBe(true);
  });

  test('mining can be aborted via AbortController', async () => {
    const chain     = createBlockchain('node-1', { ...TEST_CONFIG, difficulty: 8 }); // hard enough to abort
    const candidate = buildBlockCandidate(chain, [], { ...TEST_CONFIG, difficulty: 8 });
    const abort     = new AbortController();

    const miningPromise = mineBlock(candidate.header, 8, abort.signal);
    abort.abort();

    const result = await miningPromise;
    expect(result).toBeNull();
  });
});

// ── Tests: Chain validation ───────────────────────────────────

describe('Chain validation', () => {
  test('validates a correct chain', async () => {
    let chain = createBlockchain('node-1', TEST_CONFIG);
    const block = await mineTestBlock(chain);
    chain = addBlockToChain(chain, block, TEST_CONFIG);

    expect(validateChain(chain.blocks).valid).toBe(true);
  });

  test('detects a tampered block hash', async () => {
    let chain = createBlockchain('node-1', TEST_CONFIG);
    const block = await mineTestBlock(chain);
    chain = addBlockToChain(chain, block, TEST_CONFIG);

    // Tamper: replace hash with something that still starts with '0' but is wrong
    const tampered = chain.blocks.map((b, i) =>
      i === 1 ? { ...b, hash: '0' + b.hash.slice(1, -1) + 'f' } : b
    );

    expect(validateChain(tampered).valid).toBe(false);
  });

  test('detects broken chain linkage', async () => {
    let chain = createBlockchain('node-1', TEST_CONFIG);
    const block1 = await mineTestBlock(chain);
    chain = addBlockToChain(chain, block1, TEST_CONFIG);
    const block2 = await mineTestBlock(chain);
    chain = addBlockToChain(chain, block2, TEST_CONFIG);

    // Tamper: change block1's hash, breaking block2's previousHash link
    const tampered = chain.blocks.map((b, i) =>
      i === 1 ? { ...b, hash: sha256({ fake: true }) } : b
    );

    expect(validateChain(tampered).valid).toBe(false);
  });

  test('rejects a chain with incorrect merkle root', async () => {
    let chain = createBlockchain('node-1', TEST_CONFIG);
    const block = await mineTestBlock(chain);
    // Tamper the merkle root
    const tampered = {
      ...block,
      header: { ...block.header, merkleRoot: 'a'.repeat(64) },
    };
    // Hash won't match anyway, but let's be explicit
    expect(validateChain([chain.blocks[0], tampered]).valid).toBe(false);
  });
});

// ── Tests: Consensus ─────────────────────────────────────────

describe('Chain conflict resolution (Nakamoto consensus)', () => {
  test('replaces local chain with longer valid remote chain', async () => {
    let chain1 = createBlockchain('node-1', TEST_CONFIG);
    let chain2 = createBlockchain('node-1', TEST_CONFIG);

    const b1 = await mineTestBlock(chain1);
    chain1 = addBlockToChain(chain1, b1, TEST_CONFIG);

    const b2 = await mineTestBlock(chain2);
    chain2 = addBlockToChain(chain2, b2, TEST_CONFIG);
    const b3 = await mineTestBlock(chain2);
    chain2 = addBlockToChain(chain2, b3, TEST_CONFIG);

    const { resolved, replaced } = resolveChainConflict(chain1.blocks, chain2.blocks);
    expect(replaced).toBe(true);
    expect(resolved).toHaveLength(3);
  });

  test('keeps local chain if remote is shorter', async () => {
    let chain1 = createBlockchain('node-1', TEST_CONFIG);
    const chain2 = createBlockchain('node-1', TEST_CONFIG);

    const b1 = await mineTestBlock(chain1);
    chain1 = addBlockToChain(chain1, b1, TEST_CONFIG);

    const { replaced } = resolveChainConflict(chain1.blocks, chain2.blocks);
    expect(replaced).toBe(false);
  });

  test('keeps local chain if remote is longer but invalid', async () => {
    let chain1 = createBlockchain('node-1', TEST_CONFIG);
    const chain2 = createBlockchain('node-1', TEST_CONFIG);

    const b1 = await mineTestBlock(chain1);
    chain1 = addBlockToChain(chain1, b1, TEST_CONFIG);

    // Build an invalid longer chain (bad hashes)
    const fakeBlock: Block = {
      header: { index: 1, previousHash: 'bad', timestamp: Date.now(), merkleRoot: '0'.repeat(64), nonce: 0, difficulty: 1 },
      transactions: [],
      hash: 'not-a-real-hash',
      minedBy: 'attacker',
    };
    const fakeChain = [...chain2.blocks, fakeBlock, { ...fakeBlock, header: { ...fakeBlock.header, index: 2 } }];

    const { replaced } = resolveChainConflict(chain1.blocks, fakeChain);
    expect(replaced).toBe(false);
  });
});

// ── Tests: Pending transactions ───────────────────────────────

describe('Pending transactions', () => {
  test('are cleared from pool after block is mined', async () => {
    const { publicKey, privateKey } = generateKeyPair();
    const { publicKey: recipientKey } = generateKeyPair();

    let chain = createBlockchain('node-1', TEST_CONFIG);
    const tx  = createTransaction({ senderPublicKey: publicKey, senderPrivateKey: privateKey, recipient: recipientKey, amount: 5 });

    chain = addPendingTransaction(chain, tx);
    expect(chain.pendingTransactions).toHaveLength(1);

    const block = await mineTestBlock(chain, [tx]);
    chain       = addBlockToChain(chain, block, TEST_CONFIG);

    expect(chain.pendingTransactions).toHaveLength(0);
  });
});
