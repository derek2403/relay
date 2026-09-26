// World ID relying-party pieces, reimplemented with viem (no World package on
// the server): hash-to-field, signal hashing, and the rp_context signature
// World App checks before it shows the request.
//
// rp_context message (uniqueness proof, with an action; 81 bytes):
//   0x01 ‖ nonce (32) ‖ u64be(created_at) ‖ u64be(expires_at) ‖ hashToField(utf8(action)) (32)
// signed EIP-191 over the raw bytes (viem signMessage({ message: { raw } })).
// Without an action (session proofs, unused here) the last field is omitted (49 bytes).

import { type Address, type Hex, bytesToHex, concatBytes, hexToBytes, keccak256, numberToBytes, stringToBytes } from "viem";
import { privateKeyToAccount, privateKeyToAddress } from "viem/accounts";

import type { WorldConfig } from "./config";

export const RP_CONTEXT_TTL_SEC = 300;

/** keccak256(bytes) >> 8, as 32 bytes (fits the BN254 field). */
export function hashToField(input: Uint8Array): Uint8Array {
  const shifted = BigInt(keccak256(input)) >> 8n;
  return numberToBytes(shifted, { size: 32 });
}

const isEvenHex = (s: string) => s.length > 0 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s);

/**
 * World's signal hash: hashToField of the signal's bytes. A "0x…" signal with
 * valid even-length hex is hashed as those bytes, anything else as UTF-8
 * (Relay's signals start with text, so they always take the UTF-8 branch).
 */
export function hashSignal(signal: string): Hex {
  const bytes = signal.startsWith("0x") && isEvenHex(signal.slice(2)) ? hexToBytes(signal as Hex) : stringToBytes(signal);
  return bytesToHex(hashToField(bytes));
}

/** The raw bytes World App expects the RP to have signed. */
export function rpMessage(m: { nonce: Hex; createdAt: number; expiresAt: number; action?: string }): Uint8Array {
  const nonce = hexToBytes(m.nonce);
  if (nonce.length !== 32) throw new Error("rp nonce must be 32 bytes");
  const parts = [new Uint8Array([1]), nonce, numberToBytes(BigInt(m.createdAt), { size: 8 }), numberToBytes(BigInt(m.expiresAt), { size: 8 })];
  if (m.action !== undefined) parts.push(hashToField(stringToBytes(m.action)));
  return concatBytes(parts);
}

export type RpContext = { rp_id: string; nonce: Hex; created_at: number; expires_at: number; signature: Hex };

/** A fresh, signed rp_context for one request (uniqueness proof with the configured action). */
export async function signRpContext(
  config: Pick<WorldConfig, "rpId" | "signingKey" | "action">,
  opts: { nowSec?: number; ttlSec?: number; random?: Uint8Array } = {},
): Promise<RpContext> {
  const createdAt = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const expiresAt = createdAt + (opts.ttlSec ?? RP_CONTEXT_TTL_SEC);
  const random = opts.random ?? crypto.getRandomValues(new Uint8Array(32));
  const nonce = bytesToHex(hashToField(random));
  const raw = rpMessage({ nonce, createdAt, expiresAt, action: config.action });
  const signature = await privateKeyToAccount(config.signingKey).signMessage({ message: { raw } });
  return { rp_id: config.rpId, nonce, created_at: createdAt, expires_at: expiresAt, signature };
}

/** The address of the RP signing key (compare with the portal's "Signer address"). */
export const rpSignerAddress = (signingKey: Hex): Address => privateKeyToAddress(signingKey);
