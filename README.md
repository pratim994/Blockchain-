# Distributed Blockchain Simulator

A production-grade, distributed blockchain simulator demonstrating core concepts in **distributed systems**, **cryptography**, and **consensus algorithms** — built for a FAANG-level portfolio.

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────┐
│                      CLIENT (React)                        │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────────┐   │
│  │ Zustand  │  │  Chain    │  │   Visualizations     │   │
│  │  Store   │  │  Engine   │  │  (D3 / Canvas)       │   │
│  └──────────┘  └───────────┘  └──────────────────────┘   │
│         │                                                  │
│  WebSocket Client (exponential backoff reconnect)          │
└──────────────────────────┬─────────────────────────────────┘
                           │ wss://
                           ▼
┌──────────────────────────────────────────────────────────┐
│              NGINX Load Balancer                          │
│         (round-robin across all nodes)                   │
└──────────────────────────┬───────────────────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   Node 1     │  │   Node 2     │  │   Node 3     │
│  ─────────   │  │  ─────────   │  │  ─────────   │
│  MessageBus  │  │  MessageBus  │  │  MessageBus  │
│  Chain State │  │  Chain State │  │  Chain State │
│  PoW Miner   │  │  PoW Miner   │  │  PoW Miner   │
└──────────────┘  └──────────────┘  └──────────────┘
```

### Module Breakdown

```
blockchain-simulator/
├── shared/          # Shared types & utilities (zero runtime deps)
│   └── src/
│       ├── types/   # Block, Transaction, NetworkMessage, Config
│       └── utils/   # SHA-256, Merkle root, UUID
│
├── core/            # Pure domain logic — no I/O
│   └── src/
│       ├── crypto/        # ECDSA key generation, sign, verify
│       ├── transaction/   # Create & validate signed transactions
│       ├── pow/           # Proof-of-work mining + retargeting
│       ├── chain/         # Chain validation, consensus, state transitions
│       └── __tests__/     # Unit tests (fast, no mocks needed)
│
├── server/          # Node.js WebSocket server
│   └── src/
│       ├── config/        # Environment-driven config (12-factor)
│       ├── logger/        # Structured JSON logging
│       ├── websocket/     # MessageBus (heartbeat, typed dispatch)
│       ├── handlers/      # Blockchain protocol handlers
│       └── __tests__/     # Integration tests (real WS server)
│
├── client/          # React frontend
│   └── src/
│       ├── store/         # Zustand state management
│       ├── lib/           # WebSocket client with reconnection
│       └── components/    # BlockchainViz, NodeNetwork, Dashboard
│
└── infra/           # Docker, nginx, CI
```

---

## Core Design Decisions

### 1. Clean Architecture (Dependency Inversion)

The `core` module has **zero I/O dependencies** — no WebSockets, no HTTP, no React. This means:

- **Full testability**: every blockchain rule is a pure function testable in milliseconds
- **Framework agnosticism**: swap React for Vue, or WebSockets for gRPC, without touching the domain
- **Clear boundaries**: the `shared` module defines the contract; `core` implements it; `server`/`client` consume it

### 2. ECDSA Digital Signatures (secp256k1)

Every transaction is signed with the sender's private key using **ECDSA on secp256k1** (Bitcoin's curve) via Node's built-in `crypto` module.

```
Transaction fields signed: { id, sender, recipient, amount, timestamp }
Signature: DER-encoded, base64 stored as hex
```

**Tradeoff**: We use DER encoding for compatibility rather than raw r,s values. In a browser-only deployment you'd use the Web Crypto API with P-256 instead (better native browser support).

### 3. Proof-of-Work with Cancellation

The miner accepts an `AbortSignal`:

```typescript
const result = await mineBlock(header, difficulty, abortController.signal);
if (!result) { /* lost the race — peer found it first */ }
```

This is critical for fork handling: when a peer announces a valid block at the same height, we immediately abort our own mining rather than wasting compute.

**Tradeoff**: PoW is deliberately simple (Hashcash). A production chain (e.g. Ethereum post-merge) would use Proof-of-Stake, which is computationally trivial but requires complex validator economics.

### 4. Nakamoto Consensus (Longest Valid Chain)

```typescript
function resolveChainConflict(local, remote) {
  if (remote.length <= local.length) return { replaced: false };
  if (!validateChain(remote).valid)  return { replaced: false };
  return { resolved: remote, replaced: true };
}
```

**Tradeoff**: We use chain length rather than cumulative difficulty (Bitcoin's actual rule). The difference matters when difficulty changes between blocks — cumulative difficulty is more accurate but harder to explain. A production chain would accumulate total work.

### 5. Merkle Trees for Transaction Integrity

Each block stores a Merkle root, not a flat hash of transactions. This enables:

- **SPV (Simplified Payment Verification)**: prove a transaction is in a block without downloading the full block
- **Efficient fraud proofs**: a Merkle proof is O(log n) nodes

### 6. Event-Driven Message Bus

The server's `MessageBus` class abstracts the raw WebSocket layer:

```typescript
bus.on(MessageType.NEW_TRANSACTION, (ws, msg) => { ... });
bus.broadcast(MessageType.NEW_BLOCK_ANNOUNCEMENT, block, except: ws);
```

**Benefits**:
- Handlers are isolated and independently testable
- Protocol evolution doesn't require touching the WS layer
- Dead clients are automatically cleaned up via ping/pong heartbeats

### 7. Request/Response Correlation

Chain sync uses a correlation ID pattern (similar to RPC):

```
Client A → GET_LONGEST_CHAIN_REQUEST (correlationId: "abc")
Server   → broadcast to all peers
Peers    → GET_LONGEST_CHAIN_RESPONSE (correlationId: "abc")
Server   → waits for all peers, selects longest valid, replies to A
```

This is the same pattern used by Kafka's consumer group coordinator, gRPC bidirectional streams, and AMQP.

### 8. Immutable State Updates

All blockchain state transitions return **new objects** (no mutation):

```typescript
// Bad:  chain.blocks.push(block)
// Good: return { ...chain, blocks: [...chain.blocks, block] }
```

This enables time-travel debugging, React Strict Mode compatibility, and safe concurrent reads.

---

## Protocol Message Types

| Message Type | Direction | Description |
|---|---|---|
| `GET_LONGEST_CHAIN_REQUEST` | Client→Server | Node joining network, requests current chain |
| `GET_LONGEST_CHAIN_RESPONSE` | Server→Client | Correlated response with longest valid chain |
| `NEW_BLOCK_REQUEST` | Client→Server | Client wants all nodes to mine |
| `NEW_BLOCK_ANNOUNCEMENT` | Bidirectional | Winner broadcasts newly mined block |
| `NEW_TRANSACTION` | Client→Server | Gossip a new signed transaction |
| `BLOCK_REJECTED` | Server→Client | Server rejected an invalid block |
| `PING` / `PONG` | Bidirectional | Heartbeat / liveness |

---

## Fork Handling

When two nodes mine a block at the same height simultaneously:

```
Block 5A mined by Node 1  ──► Node 2 accepts 5A
Block 5B mined by Node 2  ──► Node 1 accepts 5B
                              ↓
                    Two competing chains exist

Block 6 mined on top of 5A (chain is now longer)
Node 2 receives 6, chain with 5A+6 is longer
Node 2 switches to chain 5A+6, 5B is orphaned
```

The `resolveChainConflict` function handles this automatically. Transactions in the orphaned block (5B) are returned to the mempool — a simplification; production nodes would re-validate against the winning chain state.

---

## Dynamic Difficulty Retargeting

Every `DIFFICULTY_RETARGET_INTERVAL` blocks, the difficulty is adjusted:

```
ratio = actual_block_time / target_block_time
if ratio < 0.5 → difficulty + 1  (too fast, make it harder)
if ratio > 2.0 → difficulty - 1  (too slow, make it easier)
else           → no change
```

This mirrors Bitcoin's two-week retarget window, simplified to avoid the multi-week simulation window.

---

## Running Locally

### Option A: Docker (Recommended)

```bash
# Start a 3-node network + React frontend
docker compose up --build

# Client UI:    http://localhost:8080
# Node 1 API:   ws://localhost:3001
# Node 2 API:   ws://localhost:3002
# Node 3 API:   ws://localhost:3003

# Scale to 5 nodes
docker compose up --scale node=5
```

### Option B: Local Development

```bash
npm ci

# Terminal 1 — Server (one node)
npm run dev:server

# Terminal 2 — Client
npm run dev:client
```

---

## Testing

```bash
# All tests
npm test

# Unit tests only (fast, no I/O)
npm run test:unit

# Integration tests (real WebSocket server)
npm run test:integration

# With coverage
npm run test:unit -- --coverage
```

### Coverage targets (enforced in CI)

| Category | Threshold |
|---|---|
| Lines | 80% |
| Functions | 80% |
| Branches | 70% |
| Statements | 80% |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `NODE_ID` | random | Unique node identifier |
| `NODE_ENV` | `development` | `development` / `production` |
| `DIFFICULTY` | `3` | PoW leading zeros required |
| `BLOCK_REWARD` | `50` | Coinbase reward (satoshis) |
| `TARGET_BLOCK_TIME_MS` | `5000` | Target ms between blocks |
| `DIFFICULTY_RETARGET` | `10` | Blocks between retargets |
| `WS_PING_INTERVAL_MS` | `30000` | Heartbeat interval |
| `WS_MAX_PAYLOAD_BYTES` | `1048576` | Max WS frame size (1 MB) |

---

## Scaling Discussion

### Current architecture (single-process per node)

The current design runs each node as a single Node.js process. This is fine for a simulator but has limits:

- **CPU-bound mining**: PoW mines in the event loop. At high difficulty, this blocks I/O handling. **Fix**: offload mining to a Worker Thread or a separate process.
- **In-memory state**: chain lives in RAM. **Fix**: persist to LevelDB (Bitcoin's actual store) or RocksDB.
- **Single point of failure**: one process crash = node down. **Fix**: process supervisor (PM2, systemd) + readiness probes.

