// Encryption and MACs for the credential store and the owner session (server only).
//
// Keys are derived from RELAY_SECRET with HKDF-SHA256, one per purpose, so the
// file key and the cookie key never coincide. The store is sealed as one
// AES-256-GCM blob (fresh salt and IV on every write): swapping, dropping or
// editing any part of the file makes it fail to open.

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export const MIN_SECRET_LENGTH = 32;

const AAD = Buffer.from("keyless-relay:credentials:v1");
const FILE_INFO = "keyless-relay credentials file v1";

/** Why RELAY_SECRET can't be used, or null when it can. */
export function secretProblem(secret: string | null | undefined): string | null {
  const s = (secret ?? "").trim();
  if (!s) return "RELAY_SECRET is not set. Set it to 32+ random characters (openssl rand -hex 32) and restart the relay.";
  if (s.length < MIN_SECRET_LENGTH) return `RELAY_SECRET is too short (${s.length} characters; at least ${MIN_SECRET_LENGTH}). Use openssl rand -hex 32.`;
  return null;
}

/** RELAY_SECRET when usable, else null. */
export const usableSecret = (secret: string | null | undefined): string | null => (secretProblem(secret) ? null : secret!.trim());

/** A 32-byte key for one purpose. */
export function deriveKey(secret: string, salt: Uint8Array, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), salt, Buffer.from(info, "utf8"), 32));
}

export type SealedFile = {
  v: 1;
  alg: "aes-256-gcm";
  kdf: "hkdf-sha256";
  salt: string;
  iv: string;
  tag: string;
  ct: string;
};

export class UnsealError extends Error {
  override name = "UnsealError";
}

export function seal(secret: string, plaintext: string): SealedFile {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret, salt, FILE_INFO), iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { v: 1, alg: "aes-256-gcm", kdf: "hkdf-sha256", salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

const b64 = (v: unknown, bytes?: number): Buffer => {
  if (typeof v !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(v)) throw new UnsealError("not base64");
  const out = Buffer.from(v, "base64");
  if (bytes !== undefined && out.length !== bytes) throw new UnsealError("wrong length");
  return out;
};

/** Opens a sealed file. Throws UnsealError when the shape is wrong, the secret differs or anything was changed. */
export function unseal(secret: string, file: unknown): string {
  const f = file as Partial<SealedFile> | null;
  if (!f || typeof f !== "object" || f.v !== 1 || f.alg !== "aes-256-gcm" || f.kdf !== "hkdf-sha256") throw new UnsealError("unknown format");
  const salt = b64(f.salt, 16);
  const iv = b64(f.iv, 12);
  const tag = b64(f.tag, 16);
  const ct = b64(f.ct);
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret, salt, FILE_INFO), iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw new UnsealError("can't be decrypted");
  }
}

/** HMAC-SHA256 (hex) under a key derived from the secret for `info`. */
export function mac(secret: string, info: string, data: string): string {
  return createHmac("sha256", deriveKey(secret, Buffer.from("keyless-relay"), info)).update(data).digest("hex");
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time string comparison (compares SHA-256 digests, so lengths don't leak). */
export const safeEqual = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

/** A short non-secret fingerprint of the secret (to notice it changed). */
export const secretFingerprint = (secret: string | null) => (secret ? digest(`fp:${secret}`).toString("hex").slice(0, 16) : "none");
