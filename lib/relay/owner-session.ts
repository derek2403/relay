// "Owner signs": the wallet that owns the company root on ENS signs in with a
// wallet signature (server only).
//
//   GET  /nonce?address=  -> a one-time nonce (in memory, 5 minutes) and the exact
//                            EIP-4361 message to sign, kept with the nonce
//   POST /session         -> the signed message; the server consumes the nonce,
//                            checks the message is the one it issued, verifies the
//                            signature, and checks on-chain that the address owns
//                            RELAY_ROOT_NAME (and equals RELAY_ROOT_OWNER when
//                            pinned); then sets the relay_owner cookie
//
// The cookie is "<address>.<expiresAt ms>.<hmac>", an HMAC (key derived from
// RELAY_SECRET) over the root name, address and expiry: HttpOnly,
// SameSite=Strict, 12 hours, Secure on https. Changing RELAY_SECRET or
// RELAY_ROOT_NAME ends every session. Cookie-authenticated writes also need a
// JSON content type and a same-origin Origin header (CSRF).

import { type Address, type Hex, getAddress, isAddress, isAddressEqual, isHex, verifyMessage } from "viem";
import { createSiweMessage, parseSiweMessage } from "viem/siwe";

import { ADMIN_COOKIE, isAdmin } from "./auth";
import type { RelayConfig } from "./config";
import { mac, safeEqual } from "./credentials-crypto";
import type { OwnerSession } from "./credentials-types";
import type { ChainReader } from "./ens";
import { TOKEN_PREFIX } from "./token";

export const OWNER_COOKIE = "relay_owner";
/** The cookie is only sent to the credentials API. */
export const OWNER_COOKIE_PATH = "/api/relay/credentials";
export const SESSION_TTL_MS = 12 * 3600_000;
export const NONCE_TTL_MS = 5 * 60_000;
export const MAX_NONCES = 1000;
export const SEPOLIA_CHAIN_ID = 11155111;

// --- Nonces ---------------------------------------------------------------------------

export type NonceRecord = { address: Address; message: string; expiresAt: number };

/** One-time sign-in nonces, kept in memory (the oldest are dropped past MAX_NONCES). */
export class NonceStore {
  private readonly items = new Map<string, NonceRecord>();

  constructor(private readonly max = MAX_NONCES) {}

  issue(address: Address, build: (nonce: string, issuedAt: Date, expiresAt: Date) => string, now = Date.now()) {
    this.sweep(now);
    const nonce = randomNonce();
    const expiresAt = now + NONCE_TTL_MS;
    const message = build(nonce, new Date(now), new Date(expiresAt));
    while (this.items.size >= this.max) this.items.delete(this.items.keys().next().value!);
    this.items.set(nonce, { address, message, expiresAt });
    return { nonce, message, expiresAt };
  }

  /** Takes a nonce out (single use). Null when unknown or expired. */
  consume(nonce: string, now = Date.now()): NonceRecord | null {
    const record = this.items.get(nonce);
    if (!record) return null;
    this.items.delete(nonce);
    return record.expiresAt > now ? record : null;
  }

  get size() {
    return this.items.size;
  }

  private sweep(now: number) {
    for (const [k, r] of this.items) if (r.expiresAt <= now) this.items.delete(k);
  }
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const g = globalThis as unknown as { __relayOwnerNonces?: NonceStore };

/** The process's nonce store (on globalThis: the nonce and session routes may be separate bundles). */
export function ownerNonces(): NonceStore {
  g.__relayOwnerNonces ??= new NonceStore();
  return g.__relayOwnerNonces;
}

// --- Message -----------------------------------------------------------------------------

export type MessageInput = { domain: string; uri: string; address: Address; root: string; nonce: string; issuedAt: Date; expiresAt: Date };

/** The EIP-4361 message the owner signs (wallets show it and check the domain). */
export function ownerMessage(m: MessageInput): string {
  return createSiweMessage({
    domain: m.domain,
    uri: m.uri,
    address: m.address,
    chainId: SEPOLIA_CHAIN_ID,
    version: "1",
    nonce: m.nonce,
    issuedAt: m.issuedAt,
    expirationTime: m.expiresAt,
    statement: `Sign in to manage the service credentials of the relay for ${m.root}. This does not send a transaction or cost gas.`,
  });
}

/** The nonce named in a signed message, or null. */
export function messageNonce(message: string): string | null {
  try {
    return parseSiweMessage(message).nonce ?? null;
  } catch {
    return null;
  }
}

// --- Session cookie -------------------------------------------------------------------------

const SESSION_INFO = "keyless-relay owner-session v1";
const sessionMac = (secret: string, root: string, address: Address, expiresAt: number) => mac(secret, SESSION_INFO, `v1|${root}|${address.toLowerCase()}|${expiresAt}`);

export function sessionToken(secret: string, root: string, address: Address, expiresAt: number): string {
  return `${getAddress(address)}.${expiresAt}.${sessionMac(secret, root, address, expiresAt)}`;
}

/** The session a cookie value proves, or null (bad MAC, other root or secret, expired). */
export function readSession(secret: string | null, root: string | null, raw: string | null, now = Date.now()): OwnerSession | null {
  if (!secret || !root || !raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [address, exp, tag] = parts;
  if (!isAddress(address, { strict: false }) || !/^\d{1,16}$/.test(exp) || !/^[0-9a-f]{64}$/.test(tag)) return null;
  const expiresAt = Number(exp);
  if (!safeEqual(tag, sessionMac(secret, root, address, expiresAt))) return null;
  if (expiresAt <= now) return null;
  return { address: getAddress(address), expiresAt };
}

export function isSecureRequest(request: Request): boolean {
  try {
    if (new URL(request.url).protocol === "https:") return true;
  } catch {}
  return request.headers.get("x-forwarded-proto")?.split(",")[0].trim() === "https";
}

export function sessionCookie(value: string, maxAgeSec: number, secure: boolean): string {
  return `${OWNER_COOKIE}=${value}; Path=${OWNER_COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
}

export function cookieValue(headers: Headers, name: string): string | null {
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) {
      try {
        return decodeURIComponent(v.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// --- Who is asking ------------------------------------------------------------------------------

export type Caller = {
  owner: OwnerSession | null;
  admin: boolean;
  /** How the admin authenticated: a bearer header needs no CSRF check, a cookie does. */
  adminVia: "bearer" | "cookie" | null;
};

export function callerFor(request: Request, config: RelayConfig, secret: string | null, now = Date.now()): Caller {
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const viaBearer = !!bearer && config.admin.enabled && !bearer.startsWith(`${TOKEN_PREFIX}.`) && config.admin.check(bearer);
  const admin = viaBearer || isAdmin(request, { config });
  const owner = config.rootError ? null : readSession(secret, config.rootName, cookieValue(request.headers, OWNER_COOKIE), now);
  return { owner, admin, adminVia: viaBearer ? "bearer" : admin ? "cookie" : null };
}

/** True when the request carries any cookie this API accepts (so a write needs the CSRF checks). */
export const usesCookieAuth = (caller: Caller) => caller.adminVia === "cookie" || (!!caller.owner && caller.adminVia !== "bearer");

export { ADMIN_COOKIE };

// --- CSRF -----------------------------------------------------------------------------------------

/** "http://127.0.0.1:3000" -> the same server under localhost / 127.0.0.1 / [::1]. */
function localAliases(origin: string): string[] {
  try {
    const url = new URL(origin);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return [url.origin];
    return ["localhost", "127.0.0.1", "[::1]"].map((h) => `${url.protocol}//${h}${url.port ? `:${url.port}` : ""}`);
  } catch {
    return [];
  }
}

/**
 * Origins a same-origin write may come from: the request's own origin and RELAY_PUBLIC_URL, each
 * with its local aliases. Next rebuilds request.url on its own host name (`next start --hostname
 * 127.0.0.1` still yields http://localhost:<port>), so a page on 127.0.0.1:<port> only matches
 * through the alias.
 */
export function allowedOrigins(request: Request, publicUrl: string): string[] {
  const own: string[] = [];
  try {
    own.push(...localAliases(new URL(request.url).origin));
  } catch {}
  return [...new Set([...own, ...localAliases(publicUrl)])];
}

/**
 * The origin the browser addressed (its Host header), when it is one of allowedOrigins; else
 * request.url's. Used for the sign-in message's domain, which wallets compare with the page: a
 * page on 127.0.0.1 must not be asked to sign for "localhost". An arbitrary Host (a server-side
 * caller) can't pick the domain, so a phishing page can't get a message naming itself.
 */
export function addressedOrigin(request: Request, publicUrl: string): URL {
  const url = new URL(request.url);
  const host = request.headers.get("host")?.trim().toLowerCase();
  const match = host ? allowedOrigins(request, publicUrl).find((origin) => new URL(origin).host === host) : undefined;
  return match ? new URL(match) : url;
}

export type Refusal = { status: number; error: string; reason: string };

/** Why a cookie-authenticated write is refused as a possible cross-site request, or null. */
export function csrfProblem(request: Request, publicUrl: string): Refusal | null {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return { status: 415, error: "unsupported content type", reason: "send the request with content-type: application/json" };
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return { status: 403, error: "cross-site request refused", reason: `sec-fetch-site is ${site}` };
  const origin = request.headers.get("origin");
  if (!origin) return { status: 403, error: "cross-site request refused", reason: "the request has no Origin header" };
  if (!allowedOrigins(request, publicUrl).includes(origin)) return { status: 403, error: "cross-site request refused", reason: `origin ${origin} is not this relay` };
  return null;
}

// --- Ownership ---------------------------------------------------------------------------------------

/**
 * Why `address` may not manage the relay's credentials, or null when it owns
 * RELAY_ROOT_NAME on-chain (and equals RELAY_ROOT_OWNER when pinned). Chain
 * read errors are thrown (ChainReadError).
 */
export async function ownerProblem(address: Address, deps: { config: RelayConfig; reader: ChainReader }): Promise<string | null> {
  const { config } = deps;
  if (!config.rootName || config.rootError) return config.rootError ?? "RELAY_ROOT_NAME is not set on the relay";
  if (config.rootOwner && !isAddressEqual(config.rootOwner, address)) {
    return `${config.rootName} is pinned to ${config.rootOwner} (RELAY_ROOT_OWNER); ${getAddress(address)} can't manage credentials`;
  }
  const [root] = await deps.reader.readLevels(config.rootName, config.rootName);
  if (!root || root.status !== "registered") return `${config.rootName} is not registered`;
  if (!root.owner || !isAddressEqual(root.owner, address)) return `${getAddress(address)} doesn't own ${config.rootName} (owner: ${root.owner ?? "nobody"})`;
  return null;
}

// --- Signature ------------------------------------------------------------------------------------------

export type VerifySignature = (args: { address: Address; message: string; signature: Hex }) => Promise<boolean>;

/** EOA signatures, checked locally (viem verifyMessage). */
export const verifyEoaSignature: VerifySignature = async ({ address, message, signature }) => {
  try {
    return await verifyMessage({ address, message, signature });
  } catch {
    return false;
  }
};

export type SignInInput = { address: unknown; message: unknown; signature: unknown };
export type SignInResult = { ok: true; address: Address } | ({ ok: false } & Refusal);

/**
 * Checks a signed sign-in message: the nonce is consumed (single use) before
 * anything else, then the message must be the one issued for this address, the
 * signature must verify and the address must own the root.
 */
export async function verifySignIn(
  input: SignInInput,
  deps: { config: RelayConfig; reader: ChainReader; nonces: NonceStore; verify: VerifySignature; now?: number },
): Promise<SignInResult> {
  const fail = (reason: string, status = 401, error = "sign-in refused"): SignInResult => ({ ok: false, status, error, reason });
  const { address, message, signature } = input;
  if (typeof address !== "string" || !isAddress(address, { strict: false })) return fail("address must be a 0x address", 400, "bad request");
  if (typeof message !== "string" || message.length > 2000) return fail("message must be the text from /api/relay/credentials/nonce", 400, "bad request");
  if (typeof signature !== "string" || !isHex(signature) || signature.length < 4 || signature.length > 20_000) return fail("signature must be 0x hex", 400, "bad request");

  const nonce = messageNonce(message);
  const record = nonce ? deps.nonces.consume(nonce, deps.now ?? Date.now()) : null;
  if (!record) return fail("This sign-in message expired or was already used. Ask for a new one.");
  if (!safeEqual(record.message, message) || !isAddressEqual(record.address, address)) return fail("The message was changed or issued for another address.");
  if (!(await deps.verify({ address: getAddress(address), message, signature: signature as Hex }))) return fail("The signature doesn't match the address.");
  const problem = await ownerProblem(getAddress(address), deps);
  if (problem) return fail(problem, 401, "not the owner");
  return { ok: true, address: getAddress(address) };
}
