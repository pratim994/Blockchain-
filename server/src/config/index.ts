// ============================================================
// server/src/config/index.ts
//
// All config is read from environment variables so the same
// Docker image can serve any environment (12-factor app).
// ============================================================

import type { BlockchainConfig } from '../../../shared/src/types';

export interface ServerConfig {
  port:             number;
  nodeId:           string;
  nodeEnv:          'development' | 'test' | 'production';
  blockchain:       BlockchainConfig;
  ws: {
    pingIntervalMs: number;
    pongTimeoutMs:  number;
    maxPayloadBytes: number;
  };
}

function getEnv(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined) throw new Error(`Required env var ${key} is not set.`);
  return value;
}

function getEnvInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) throw new Error(`Env var ${key} must be an integer, got "${raw}".`);
  return parsed;
}

export function loadConfig(): ServerConfig {
  return {
    port:    getEnvInt('PORT', 3000),
    nodeId:  getEnv('NODE_ID', `node-${Math.random().toString(36).slice(2, 8)}`),
    nodeEnv: (getEnv('NODE_ENV', 'development') as ServerConfig['nodeEnv']),

    blockchain: {
      difficulty:               getEnvInt('DIFFICULTY',              3),
      maxBlockTransactions:     getEnvInt('MAX_BLOCK_TRANSACTIONS',  10),
      blockReward:              getEnvInt('BLOCK_REWARD',            50),
      targetBlockTimeMs:        getEnvInt('TARGET_BLOCK_TIME_MS',    5000),
      difficultyRetargetInterval: getEnvInt('DIFFICULTY_RETARGET',   10),
    },

    ws: {
      pingIntervalMs:  getEnvInt('WS_PING_INTERVAL_MS',  30_000),
      pongTimeoutMs:   getEnvInt('WS_PONG_TIMEOUT_MS',   10_000),
      maxPayloadBytes: getEnvInt('WS_MAX_PAYLOAD_BYTES',  1_048_576), // 1 MB
    },
  };
}
