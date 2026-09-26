// Admin sign-in with the company owner's wallet (server only), next to the
// token sign-in at /api/relay/admin:
//
//   GET  /api/relay/admin/wallet?address=  -> a one-time nonce (in memory, 5 minutes) and the
//                                             exact EIP-4361 message to sign: this relay's
//                                             origin, the company root, the wallet, the nonce
//                                             and the expiry. A wallet that doesn't own the root
//                                             is refused here, before it is asked to sign.
//   POST /api/relay/admin/wallet            -> {address, message, signature}: the message must
//                                             name this origin and root; the nonce is consumed
//                                             (single use), the message must be the one issued
//                                             for this address, the signature must verify and
//                                             the wallet must own RELAY_ROOT_NAME on-chain right
//                                             now (and equal RELAY_ROOT_OWNER when pinned). Then
//                                             the same relay_admin cookie the token sign-in sets,
//                                             so every admin check works unchanged.
//
// Every refused sign-in spends one of the client's failures (relayLimits), like a wrong token on
// the token page; a chain outage doesn't.
//
// Only while admin sign-in is on (RELAY_ADMIN_TOKEN set): the cookie is an HMAC of the token, so
// without one there is no session to hand out, and "open" / "closed" relays stay as they are.
// The owner sign-in for credentials (owner-session.ts) supplies the nonce store, message format,
// ownership check and signature check; these nonces are a separate store and the statement
// differs, so a credentials sign-in message never signs anyone in as admin (or the reverse).

import { getAddress } from "viem";
import { parseSiweMessage } from "viem/siwe";

import { ADMIN_SESSION_SEC, adminCookie, jsonError } from "./auth";
import { type RelayConfig, getConfig } from "./config";
import type { NonceResponse } from "./credentials-types";
import { type ChainReader, getChainReader, isChainReadError } from "./ens";
import {
  NonceStore,
  type SignInInput,
  type SignInResult,
  type VerifySignature,
  addressedOrigin,
  csrfProblem,
  isSecureRequest,
  messageNonce,
  nonceLimit,
  ownerMessage,
  ownerProblem,
  signatureVerifier,
  verifySignIn,
} from "./owner-session";
import { type ClientLimit, type RelayLimits, clientKey, relayLimits } from "./ratelimit";
import type { AdminSessionResponse } from "./types";

export type AdminWalletDeps = {
  config: RelayConfig;
  reader: ChainReader;
  /** failures: every refused sign-in spends one, like the relay's other sign-ins. */
  limits: RelayLimits;
  nonces: NonceStore;
  /** Nonce requests: each nonce sits in memory until it is used or expires. */
  nonceLimit: ClientLimit;
  verify: VerifySignature;
  now?: () => number;
};

const g = globalThis as unknown as { __relayAdminNonces?: NonceStore };

/** The admin sign-in nonces (on globalThis like the owner's, and kept apart from them). */
export function adminNonces(): NonceStore {
  g.__relayAdminNonces ??= new NonceStore();
  return g.__relayAdminNonces;
}

/** Dependencies for the running server. */
export function adminWalletDeps(): AdminWalletDeps {
  const config = getConfig();
  return {
    config,
    reader: getChainReader(config.rpcUrl, config.logsRpcUrl),
    limits: relayLimits(),
    nonces: adminNonces(),
    nonceLimit: nonceLimit(),
    verify: signatureVerifier(config.rpcUrl),
  };
}

/** What the wallet shows the owner. Names the root, so a message for another company's relay is refused. */
export const adminStatement = (root: string) =>
  `Sign in as the admin of the relay for ${root} to see spend and the decision log. This does not send a transaction or cost gas.`;

const NO_STORE = { "cache-control": "no-store" };
const nowOf = (deps: Pick<AdminWalletDeps, "now">) => deps.now?.() ?? Date.now();
const MAX_BODY = 16 * 1024;

/** Refusals that don't depend on the request: admin sign-in off, or no company root to own. */
function unavailable(config: RelayConfig): Response | null {
  if (!config.admin.enabled) {
    return jsonError(
      404,
      "admin sign-in is off",
      config.viewAuth === "open"
        ? "RELAY_ADMIN_TOKEN is not set, so this relay shows spend and its log to anyone (development). There is nothing to sign in to."
        : "RELAY_ADMIN_TOKEN is not set, so nobody can sign in as admin. Set it in the relay's environment and restart.",
    );
  }
  if (config.rootError) return jsonError(503, "no company root", config.rootError);
  if (!config.rootName) return jsonError(503, "no company root", "RELAY_ROOT_NAME is not set on the relay, so there is no owner to sign in.");
  return null;
}

/** The relay origin the message names: the one the browser addressed when it is this relay (addressedOrigin). */
function originOf(request: Request, config: RelayConfig): URL {
  try {
    return addressedOrigin(request, config.publicUrl);
  } catch {
    return new URL(config.publicUrl);
  }
}

function failure(err: unknown): Response {
  if (isChainReadError(err)) return jsonError(502, "ENS read failed", err.message);
  console.error("[relay] admin wallet sign-in:", err instanceof Error ? err.name : "error");
  return jsonError(500, "internal error", "the sign-in failed");
}

/** The request's JSON object body, or null (not JSON, not an object, over MAX_BODY). */
async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return null;
  const text = await request.text().catch(() => "");
  if (text.length > MAX_BODY) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// --- GET /api/relay/admin/wallet?address= ------------------------------------------------------------

export async function getAdminChallenge(request: Request, deps: AdminWalletDeps): Promise<Response> {
  const off = unavailable(deps.config);
  if (off) return off;
  const client = clientKey(request.headers);
  if (!deps.limits.failures.has(client)) return jsonError(429, "too many failed sign-ins", "Wait a minute and try again.", { "retry-after": "60" });
  if (!deps.nonceLimit.take(client)) return jsonError(429, "too many sign-in requests", "Wait a few seconds and try again.", { "retry-after": "5" });
  const raw = new URL(request.url).searchParams.get("address") ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return jsonError(400, "bad request", "pass ?address=0x… (the wallet that will sign)");
  const address = getAddress(raw.toLowerCase());
  const root = deps.config.rootName!;
  // Say so before the wallet is asked to sign (a refused sign-in, so it spends a failure); POST
  // checks again, since the root can change hands meanwhile.
  try {
    const problem = await ownerProblem(address, deps);
    if (problem) {
      deps.limits.failures.spend(client);
      return jsonError(403, "not the owner", problem);
    }
  } catch (err) {
    return failure(err);
  }
  const origin = originOf(request, deps.config);
  try {
    const issued = deps.nonces.issue(
      address,
      (nonce, issuedAt, expiresAt) => ownerMessage({ domain: origin.host, uri: origin.origin, address, root, nonce, issuedAt, expiresAt }, adminStatement(root)),
      nowOf(deps),
    );
    return Response.json(issued satisfies NonceResponse, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}

// --- POST /api/relay/admin/wallet --------------------------------------------------------------------

/** Why a signed message isn't an admin sign-in for this relay's origin and root, or null. */
function messageProblem(message: string, origin: URL, root: string | null): string | null {
  const m = parseSiweMessage(message);
  if (!m.domain || !m.nonce) return "This is not a sign-in message from this relay. Ask for a new one.";
  if (m.domain !== origin.host || m.uri !== origin.origin) return `The message signs in to ${m.domain}, not ${origin.host}. Ask for a new one on this page.`;
  if (!root || m.statement !== adminStatement(root)) return `The message isn't an admin sign-in for ${root ?? "this relay"}. Ask for a new one.`;
  return null;
}

/**
 * Checks a signed admin sign-in. The message must name `origin` and the relay's root (else its
 * nonce is burned and it is refused); then verifySignIn: the nonce is consumed (single use,
 * unexpired), the message must be exactly the one issued for this address, the signature must
 * verify, and the address must own the root on-chain now. Chain read errors are thrown.
 */
export async function verifyAdminSignIn(
  input: SignInInput,
  origin: URL,
  deps: Pick<AdminWalletDeps, "config" | "reader" | "nonces" | "verify"> & { now?: number },
): Promise<SignInResult> {
  const { message } = input;
  if (typeof message !== "string" || message.length > 2000) {
    return { ok: false, status: 400, error: "bad request", reason: "message must be the text from GET /api/relay/admin/wallet" };
  }
  const problem = messageProblem(message, origin, deps.config.rootName);
  if (problem) {
    const nonce = messageNonce(message);
    if (nonce) deps.nonces.consume(nonce, deps.now);
    return { ok: false, status: 401, error: "sign-in refused", reason: problem };
  }
  return verifySignIn(input, deps);
}

export async function postAdminWallet(request: Request, deps: AdminWalletDeps): Promise<Response> {
  const off = unavailable(deps.config);
  if (off) return off;
  const csrf = csrfProblem(request, deps.config.publicUrl);
  if (csrf) return jsonError(csrf.status, csrf.error, csrf.reason);
  const body = await readJson(request);
  if (!body) return jsonError(400, "bad request", 'send JSON: {"address", "message", "signature"}');
  const client = clientKey(request.headers);
  if (!deps.limits.failures.has(client)) return jsonError(429, "too many failed sign-ins", "Wait a minute and try again.", { "retry-after": "60" });

  let result: SignInResult;
  try {
    result = await verifyAdminSignIn({ address: body.address, message: body.message, signature: body.signature }, originOf(request, deps.config), {
      ...deps,
      now: nowOf(deps),
    });
  } catch (err) {
    return failure(err);
  }
  if (!result.ok) {
    deps.limits.failures.spend(client);
    return jsonError(result.status, result.error, result.reason);
  }
  return Response.json({ admin: true, address: result.address } satisfies AdminSessionResponse, {
    headers: { ...NO_STORE, "set-cookie": adminCookie(deps.config.admin.cookie()!, ADMIN_SESSION_SEC, isSecureRequest(request)) },
  });
}
