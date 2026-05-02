// ============================================================
// core/src/crypto/ecdsa.ts
//
// ECDSA (secp256k1) digital signatures — same curve Bitcoin uses.
// Wraps Node's built-in `crypto` — zero external dependencies.
// ============================================================

import {
  generateKeyPairSync,
  createSign,
  createVerify,
  createPrivateKey,
  createPublicKey,
} from 'crypto';
import type { PublicKey, Signature } from '../../../shared/src/types';

export interface KeyPair {
  publicKey: PublicKey;   // SPKI DER hex
  privateKey: string;     // PKCS8 DER hex — NEVER leave the client
}

/**
 * Generate a fresh secp256k1 key pair.
 */
export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'secp256k1',
    publicKeyEncoding:  { type: 'spki',  format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  return {
    publicKey:  (publicKey  as unknown as Buffer).toString('hex'),
    privateKey: (privateKey as unknown as Buffer).toString('hex'),
  };
}

/**
 * Sign arbitrary data with a PKCS8 DER private key (hex-encoded).
 */
export function signData(data: unknown, privateKeyHex: string): Signature {
  const signer = createSign('SHA256');
  signer.update(JSON.stringify(data));

  const keyObject = createPrivateKey({
    key:    Buffer.from(privateKeyHex, 'hex'),
    format: 'der',
    type:   'pkcs8',
  });

  return signer.sign(keyObject, 'hex');
}

/**
 * Verify an ECDSA signature against a SPKI DER public key (hex-encoded).
 * Returns false on any error — tampered data, wrong key, malformed input.
 */
export function verifySignature(
  data: unknown,
  signature: Signature,
  publicKeyHex: PublicKey
): boolean {
  try {
    const verifier = createVerify('SHA256');
    verifier.update(JSON.stringify(data));

    const keyObject = createPublicKey({
      key:    Buffer.from(publicKeyHex, 'hex'),
      format: 'der',
      type:   'spki',
    });

    return verifier.verify(keyObject, signature, 'hex');
  } catch {
    return false;
  }
}