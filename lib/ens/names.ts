import { type Hex, bytesToHex, keccak256, stringToBytes } from "viem";
import { labelhash, namehash, normalize, packetToBytes } from "viem/ens";

export { labelhash, namehash, normalize };

/** DNS wire-format encoding of a name, as taken by UniversalResolver/findResolver etc. */
export const dnsEncode = (name: string): Hex => bytesToHex(packetToBytes(name));

/** Normalizes user input, returning `null` instead of throwing on invalid names. */
export function tryNormalize(name: string): string | null {
  try {
    return normalize(name.trim());
  } catch {
    return null;
  }
}

/** Splits `sub.nick.eth` into ["sub", "nick", "eth"]. The root name is "". */
export const splitLabels = (name: string) => (name === "" ? [] : name.split("."));

/** First label and parent name: `sub.nick.eth` -> ["sub", "nick.eth"]. */
export function splitFirst(name: string): [label: string, parent: string] {
  const i = name.indexOf(".");
  return i === -1 ? [name, ""] : [name.slice(0, i), name.slice(i + 1)];
}

// --- Mutable token IDs (see /ensv2/mutable-token-ids) ---------------------
//
// Canonical ID, token ID and resource share the upper 224 bits (from the
// labelhash) and differ only in their lower 32 bits:
//   canonical: 0x00000000   token: tokenVersionId   resource: eacVersionId

const LOW_32 = 0xffffffffn;

/** uint256 labelhash, usable as an `anyId` on PermissionedRegistry functions. */
export const labelId = (label: string): bigint => BigInt(keccak256(stringToBytes(label)));

/** Mirrors the registry's `anyId ^ uint32(anyId)`. */
export const canonicalId = (anyId: bigint): bigint => anyId & ~LOW_32;

/** Replaces the lower 32 bits of `anyId` with `version`. */
export const withVersion = (anyId: bigint, version: number | bigint): bigint =>
  canonicalId(anyId) | (BigInt(version) & LOW_32);

/** The version counter encoded in the lower 32 bits of a token ID or resource. */
export const versionOf = (id: bigint): number => Number(id & LOW_32);

/** Parses a decimal or 0x-hex uint256 string; returns null if invalid. */
export function parseUint256(input: string): bigint | null {
  const s = input.trim();
  if (!/^(0x[0-9a-fA-F]{1,64}|[0-9]+)$/.test(s)) return null;
  const v = BigInt(s);
  return v < 1n << 256n ? v : null;
}

/**
 * Parses an `anyId` input: a label (hashed), or a decimal/hex uint256
 * (token ID, resource, labelhash or canonical ID).
 */
export function parseAnyId(input: string): bigint | null {
  const n = parseUint256(input);
  if (n !== null) return n;
  const s = input.trim();
  return s && !s.includes(".") ? labelId(s) : null;
}
