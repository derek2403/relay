// Request handlers behind /api/relay/credentials/** (server only). The route
// files are thin wrappers; everything here takes its dependencies as an
// argument so tests can run it with a fake chain and a temp directory.
//
// Reads are open (anonymous callers see only whether each key is set, where it
// comes from and when it changed); hints and non-secret values need the owner
// session or the admin. Writes need one of them, the CSRF checks when a cookie
// authenticates, and (for the owner) a fresh on-chain ownership check. No
// response ever carries a secret value.

import { type Address, createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";

import { jsonError } from "./auth";
import { type RelayConfig, getConfig } from "./config";
import { type CredentialsRuntime, CredentialsError, applyCredentials, credentialsRuntime, customView, customViews, keyView, keyViews } from "./credentials";
import { secretProblem, usableSecret } from "./credentials-crypto";
import { type CredentialsResponse, type NonceResponse, type SessionResponse, slotFor } from "./credentials-types";
import { type ChainReader, getChainReader, isChainReadError } from "./ens";
import {
  type Caller,
  type NonceStore,
  SESSION_TTL_MS,
  type VerifySignature,
  callerFor,
  addressedOrigin,
  csrfProblem,
  isSecureRequest,
  ownerMessage,
  ownerNonces,
  ownerProblem,
  sessionCookie,
  sessionToken,
  usesCookieAuth,
  verifyEoaSignature,
  verifySignIn,
} from "./owner-session";
import { ClientLimit, type RelayLimits, clientKey, relayLimits } from "./ratelimit";

type Env = Record<string, string | undefined>;

export type CredentialsDeps = {
  config: RelayConfig;
  reader: ChainReader;
  /** The environment the store is applied to (process.env in the server). */
  env: Env;
  runtime: CredentialsRuntime;
  limits: RelayLimits;
  nonces: NonceStore;
  verify: VerifySignature;
  now?: () => number;
};

/** EOA signatures locally; anything else (a smart-contract wallet) through ERC-1271 / ERC-6492 on Sepolia. */
export function signatureVerifier(rpcUrl: string): VerifySignature {
  return async (args) => {
    if (await verifyEoaSignature(args)) return true;
    try {
      const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl, { timeout: 10_000 }) });
      return await client.verifyMessage(args);
    } catch {
      return false;
    }
  };
}

/** Dependencies for the running server. Applies the store to process.env on the way. */
export function credentialsDeps(): CredentialsDeps {
  const config = getConfig();
  return {
    config,
    reader: getChainReader(config.rpcUrl),
    env: process.env,
    runtime: credentialsRuntime(process.env),
    limits: relayLimits(),
    nonces: ownerNonces(),
    verify: signatureVerifier(config.rpcUrl),
  };
}

const NO_STORE = { "cache-control": "no-store" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
const nowOf = (deps: CredentialsDeps) => deps.now?.() ?? Date.now();
const secretOf = (deps: CredentialsDeps) => usableSecret(deps.env.RELAY_SECRET);
const MAX_BODY = 16 * 1024;

const tooLarge = () => new CredentialsError(413, "body too large", `at most ${MAX_BODY} bytes`);

/**
 * The body as text, refusing more than MAX_BODY bytes without buffering them: a declared
 * content-length over the limit is refused unread, and a chunked body is cancelled mid-stream.
 */
async function readLimited(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY) throw tooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** The request's JSON object body ({} when empty). */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await readLimited(request);
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CredentialsError(400, "bad request", "the body is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CredentialsError(400, "bad request", "the body must be a JSON object");
  return parsed as Record<string, unknown>;
}

/** By name, not instanceof: the shared store may come from another bundle's copy of the class. */
const isCredentialsError = (e: unknown): e is CredentialsError => e instanceof Error && e.name === "CredentialsError" && typeof (e as CredentialsError).status === "number";

function fail(err: unknown): Response {
  if (isCredentialsError(err)) return jsonError(err.status, err.error, err.reason);
  if (isChainReadError(err)) return jsonError(502, "ENS read failed", err.message);
  console.error("[relay] credentials:", err instanceof Error ? err.name : "error");
  return jsonError(500, "internal error", "the credentials request failed");
}

/** Sign-in needs RELAY_SECRET and a valid RELAY_ROOT_NAME. */
function signInUnavailable(deps: CredentialsDeps): Response | null {
  const problem = secretProblem(deps.env.RELAY_SECRET);
  if (problem) return jsonError(503, "credentials unavailable", problem);
  if (deps.config.rootError) return jsonError(503, "no company root", deps.config.rootError);
  if (!deps.config.rootName) return jsonError(503, "no company root", "RELAY_ROOT_NAME is not set on the relay, so nobody can sign in as its owner.");
  return null;
}

// --- GET /api/relay/credentials -----------------------------------------------------------------

export function getCredentials(request: Request, deps: CredentialsDeps): Response {
  const caller = callerFor(request, deps.config, secretOf(deps), nowOf(deps));
  const privileged = !!caller.owner || caller.admin;
  const { store, binding } = deps.runtime;
  const body: CredentialsResponse = {
    owner: caller.owner,
    admin: caller.admin,
    secretConfigured: !secretProblem(deps.env.RELAY_SECRET),
    root: deps.config.rootName,
    // The path and OS error are for the owner/admin (and the server log), not anonymous callers.
    storeError: store.error ? (privileged ? store.error : "sign in as the owner or admin to see why.") : null,
    keys: keyViews(store, binding, deps.env, privileged),
    custom: customViews(store, privileged),
  };
  return json(body);
}

// --- GET /api/relay/credentials/nonce?address= ----------------------------------------------------

const gl = globalThis as unknown as { __relayNonceLimit?: ClientLimit };

/** Nonces are kept in memory (at most 1000), so issuing them is limited: 20 per client (one every 2 s after that), 300 overall. */
function nonceLimit(): ClientLimit {
  gl.__relayNonceLimit ??= new ClientLimit([20, 0.5], [300, 5]);
  return gl.__relayNonceLimit;
}

export function getNonce(request: Request, deps: CredentialsDeps, limit: ClientLimit = nonceLimit()): Response {
  const unavailable = signInUnavailable(deps);
  if (unavailable) return unavailable;
  if (!limit.take(clientKey(request.headers))) return jsonError(429, "too many sign-in requests", "Wait a few seconds and try again.", { "retry-after": "5" });
  const url = new URL(request.url);
  const raw = url.searchParams.get("address") ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return jsonError(400, "bad request", "pass ?address=0x… (the wallet that will sign)");
  const address = raw as Address;
  const root = deps.config.rootName!;
  // The domain and URI the wallet shows: the host the browser addressed (if it is this relay), else RELAY_PUBLIC_URL.
  const build = (nonce: string, issuedAt: Date, expiresAt: Date) => {
    try {
      const site = addressedOrigin(request, deps.config.publicUrl);
      return ownerMessage({ domain: site.host, uri: site.origin, address, root, nonce, issuedAt, expiresAt });
    } catch {
      const pub = new URL(deps.config.publicUrl);
      return ownerMessage({ domain: pub.host, uri: pub.origin, address, root, nonce, issuedAt, expiresAt });
    }
  };
  try {
    const issued = deps.nonces.issue(address, build, nowOf(deps));
    return json(issued satisfies NonceResponse);
  } catch (err) {
    return fail(err);
  }
}

// --- POST /api/relay/credentials/session ------------------------------------------------------------

export async function postSession(request: Request, deps: CredentialsDeps): Promise<Response> {
  const csrf = csrfProblem(request, deps.config.publicUrl);
  if (csrf) return jsonError(csrf.status, csrf.error, csrf.reason);
  let body: Record<string, unknown>;
  try {
    body = await readBody(request);
  } catch (err) {
    return fail(err);
  }
  const secure = isSecureRequest(request);
  if (body.action === "signout") return json({ owner: null } satisfies SessionResponse, 200, { "set-cookie": sessionCookie("", 0, secure) });

  const unavailable = signInUnavailable(deps);
  if (unavailable) return unavailable;
  const client = clientKey(request.headers);
  if (!deps.limits.failures.has(client)) return jsonError(429, "too many failed sign-ins", "Wait a minute and try again.", { "retry-after": "60" });

  const now = nowOf(deps);
  let result;
  try {
    result = await verifySignIn({ address: body.address, message: body.message, signature: body.signature }, { ...deps, now });
  } catch (err) {
    return fail(err);
  }
  if (!result.ok) {
    deps.limits.failures.spend(client);
    return jsonError(result.status, result.error, result.reason);
  }
  const expiresAt = now + SESSION_TTL_MS;
  const value = sessionToken(secretOf(deps)!, deps.config.rootName!, result.address, expiresAt);
  return json({ owner: { address: result.address, expiresAt } } satisfies SessionResponse, 200, {
    "set-cookie": sessionCookie(value, Math.floor(SESSION_TTL_MS / 1000), secure),
  });
}

// --- Writes -----------------------------------------------------------------------------------------

/** The caller when it may write, or the refusal. */
async function writer(request: Request, deps: CredentialsDeps): Promise<Caller | Response> {
  const problem = secretProblem(deps.env.RELAY_SECRET);
  if (problem) return jsonError(503, "credentials unavailable", problem);
  const caller = callerFor(request, deps.config, secretOf(deps), nowOf(deps));
  if (!caller.owner && !caller.admin) {
    const who = deps.config.rootName ? `the wallet that owns ${deps.config.rootName}` : "the root owner's wallet";
    return jsonError(401, "not signed in", `Sign in with ${who}, or as the relay admin.`);
  }
  if (usesCookieAuth(caller)) {
    const csrf = csrfProblem(request, deps.config.publicUrl);
    if (csrf) return jsonError(csrf.status, csrf.error, csrf.reason);
  }
  if (!caller.admin && caller.owner) {
    // The root may have changed hands since sign-in.
    try {
      const lost = await ownerProblem(caller.owner.address, deps);
      if (lost) return jsonError(403, "not the owner", lost, { "set-cookie": sessionCookie("", 0, isSecureRequest(request)) });
    } catch (err) {
      return fail(err);
    }
  }
  const storeProblem = deps.runtime.store.writeProblem();
  if (storeProblem) return jsonError(503, "credentials unavailable", storeProblem);
  return caller;
}

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/** PUT /api/relay/credentials/keys/<ENV> {value: string|null}; DELETE clears. */
export async function writeKey(request: Request, envName: string, deps: CredentialsDeps, clear: boolean): Promise<Response> {
  const slot = ENV_NAME.test(envName) ? slotFor(envName) : null;
  if (!slot) return jsonError(404, "unknown key", `${envName.slice(0, 64)} is not a key this relay stores`);
  const caller = await writer(request, deps);
  if (caller instanceof Response) return caller;
  try {
    let value: unknown = null;
    if (!clear) {
      const body = await readBody(request);
      if (!("value" in body) || (body.value !== null && typeof body.value !== "string")) throw new CredentialsError(400, "bad request", "send {\"value\": \"…\"} (null or \"\" clears it)");
      value = body.value;
    }
    deps.runtime.store.setKey(slot.env, value, nowOf(deps));
    applyCredentials(deps.runtime, deps.env);
    return json(keyView(slot, deps.runtime.store, deps.runtime.binding, deps.env, true));
  } catch (err) {
    return fail(err);
  }
}

/** PUT /api/relay/credentials/custom {label, value?, note?}: adds a credential-only service. */
export async function createCustom(request: Request, deps: CredentialsDeps): Promise<Response> {
  const caller = await writer(request, deps);
  if (caller instanceof Response) return caller;
  try {
    const body = await readBody(request);
    const id = deps.runtime.store.addCustom({ label: body.label, value: body.value, note: body.note }, nowOf(deps));
    return json(customView(id, deps.runtime.store.data.custom[id], true), 201);
  } catch (err) {
    return fail(err);
  }
}

const CUSTOM_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** PUT /api/relay/credentials/custom/<id> {label?, value?, note?}; DELETE removes it. */
export async function writeCustom(request: Request, id: string, deps: CredentialsDeps, remove: boolean): Promise<Response> {
  if (!CUSTOM_ID.test(id)) return jsonError(404, "unknown service", "no such custom service");
  const caller = await writer(request, deps);
  if (caller instanceof Response) return caller;
  try {
    const { store } = deps.runtime;
    if (remove) {
      const gone = store.deleteCustom(id);
      return json({ ...customView(id, { ...gone, value: null, updatedAt: nowOf(deps) }, true), deleted: true });
    }
    const body = await readBody(request);
    store.updateCustom(id, { label: body.label, value: body.value, note: body.note }, nowOf(deps));
    return json(customView(id, store.data.custom[id], true));
  } catch (err) {
    return fail(err);
  }
}
