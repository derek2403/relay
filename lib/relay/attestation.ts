// GET /api/relay/attestation (server only): a TDX quote from dstack that binds
// the relay's statement (attestation-core.ts).
//
// The relay asks the dstack guest agent for a quote over reportData with
// @phala/dstack-sdk: inside a dstack CVM through /var/run/dstack.sock, or, when
// DSTACK_SIMULATOR_ENDPOINT is set, Phala's dstack simulator (then `source` is
// "simulator": the quote is shaped like a real one but proves nothing about
// hardware). When neither answers within 5 s the route returns 503
// {reason: "no-tee"}. Calls without a nonce are cached for 30 s (and share one
// request in flight); calls with a nonce are rate limited.

import { type RelayConfig, getConfig } from "./config";
import { CATALOG } from "./catalog";
import {
  type AttestationInfo,
  type AttestationResponse,
  type AttestationStatement,
  type AttestationUnavailable,
  PHALA_VERIFY_URL,
  canonicalJson,
  fromHex,
  parseNonce,
  parseTdxQuote,
  reportDataFor,
  statementHash,
  strip0x,
} from "./attestation-core";
import { credentialsRuntime } from "./credentials";
import { ClientLimit, clientKey } from "./ratelimit";

type Env = Record<string, string | undefined>;

/** What the route needs from a dstack client (DstackClient in production, fakes in tests). */
export type Quoter = {
  getQuote(reportData: Uint8Array): Promise<{ quote: string; event_log?: string }>;
  info?(): Promise<unknown>;
};

export type AttestationDeps = {
  config: RelayConfig;
  env: Env;
  /** Connects to dstack; throws when there is nothing to connect to. */
  quoter: () => Promise<Quoter>;
  timeoutMs?: number;
  now?: () => number;
};

export const ATTESTATION_TIMEOUT_MS = 5_000;
export const ATTESTATION_CACHE_MS = 30_000;

export const NO_TEE_HINT =
  "Run Phala's dstack simulator next to the relay (phala simulator start) and set DSTACK_SIMULATOR_ENDPOINT=http://localhost:8090, or run the relay inside a dstack CVM (Phala Cloud).";

export class NoTeeError extends Error {
  override name = "NoTeeError";
}

/** The statement for this relay right now. */
export function buildStatement(config: RelayConfig, env: Env, nonce: string | null, now = Date.now()): AttestationStatement {
  const build = (env.RELAY_BUILD_ID ?? "").trim().slice(0, 128);
  return {
    v: 1,
    relay: `${config.publicUrl}/api/relay`,
    root: config.rootName,
    rootOwner: config.rootOwner,
    services: CATALOG.map((p) => ({ id: p.id, configured: config.isConfigured(p.id) })),
    build: build || null,
    issuedAt: new Date(now).toISOString(),
    nonce,
  };
}

export const attestationSource = (env: Env): "simulator" | "tee" => ((env.DSTACK_SIMULATOR_ENDPOINT ?? "").trim() ? "simulator" : "tee");

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** The non-secret identity fields of dstack's info(). */
export function trimInfo(raw: unknown): AttestationInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const info: AttestationInfo = {
    appId: str(r.app_id),
    instanceId: str(r.instance_id),
    appName: str(r.app_name),
    composeHash: str(r.compose_hash),
    osImageHash: str(r.os_image_hash),
    deviceId: str(r.device_id),
  };
  const kept = Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined)) as AttestationInfo;
  return Object.keys(kept).length ? kept : undefined;
}

function parseEventLog(raw: unknown): unknown[] | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const short = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 200);

/** Builds the statement and gets a quote over it. Throws NoTeeError when dstack isn't reachable. */
export async function attest(deps: AttestationDeps, nonce: string | null, statement = buildStatement(deps.config, deps.env, nonce, deps.now?.() ?? Date.now())): Promise<AttestationResponse> {
  const ms = deps.timeoutMs ?? ATTESTATION_TIMEOUT_MS;
  const hash = statementHash(statement);
  const reportData = reportDataFor(hash, statement.nonce);
  let quoter: Quoter;
  try {
    quoter = await deps.quoter();
  } catch (err) {
    throw new NoTeeError(short(err));
  }
  const infoP = quoter.info ? withTimeout(quoter.info(), ms, "dstack info").then(trimInfo, () => undefined) : Promise.resolve(undefined);
  let got: { quote: string; event_log?: string };
  try {
    got = await withTimeout(quoter.getQuote(fromHex(reportData)), ms, "dstack");
  } catch (err) {
    throw new NoTeeError(short(err));
  }
  if (!got || typeof got.quote !== "string" || !got.quote) throw new NoTeeError("dstack returned no quote");
  const quote = strip0x(got.quote);
  const info = await infoP;
  return {
    statement,
    statementHash: hash,
    reportData,
    quote,
    eventLog: parseEventLog(got.event_log),
    source: attestationSource(deps.env),
    ...(info ? { info } : {}),
    verifyUrl: PHALA_VERIFY_URL,
    measurements: parseTdxQuote(quote),
  };
}

// --- Default dstack client --------------------------------------------------------------------------

/** A DstackClient for DSTACK_SIMULATOR_ENDPOINT or the CVM socket (the constructor throws when the socket is missing). */
export async function dstackQuoter(env: Env = process.env): Promise<Quoter> {
  const endpoint = (env.DSTACK_SIMULATOR_ENDPOINT ?? "").trim() || undefined;
  const { DstackClient } = await import("@phala/dstack-sdk");
  return new DstackClient(endpoint);
}

export function attestationDeps(): AttestationDeps {
  credentialsRuntime(process.env); // stored keys count as configured
  return { config: getConfig(), env: process.env, quoter: () => dstackQuoter(process.env) };
}

// --- Handler --------------------------------------------------------------------------------------------

type Cached = { key: string; at: number; value: AttestationResponse };
const g = globalThis as unknown as {
  __relayAttestation?: Cached;
  __relayAttestationInflight?: Map<string, Promise<AttestationResponse>>;
  __relayAttestationLimit?: ClientLimit;
};

/** Nonce requests each cost a quote: 10 per client (one every 5 s after that), 120 overall. */
function nonceLimit(): ClientLimit {
  g.__relayAttestationLimit ??= new ClientLimit([10, 0.2], [120, 2]);
  return g.__relayAttestationLimit;
}

const NO_STORE = { "cache-control": "no-store" };

/** Clears the cache (tests). */
export function resetAttestationCache() {
  g.__relayAttestation = undefined;
  g.__relayAttestationInflight = undefined;
}

export async function handleAttestation(request: Request, deps: AttestationDeps, limit: ClientLimit = nonceLimit()): Promise<Response> {
  let nonce: string | null;
  try {
    nonce = parseNonce(new URL(request.url).searchParams.get("nonce"));
  } catch (err) {
    return Response.json({ error: "bad nonce", reason: short(err) }, { status: 400, headers: NO_STORE });
  }
  const now = deps.now?.() ?? Date.now();
  try {
    if (nonce) {
      if (!limit.take(clientKey(request.headers))) return Response.json({ error: "too many attestation requests", reason: "Wait a few seconds and try again." }, { status: 429, headers: { ...NO_STORE, "retry-after": "5" } });
      return Response.json(await attest(deps, nonce), { headers: NO_STORE });
    }
    // Without a nonce: one quote serves every caller for 30 s while the statement (apart from its time) is unchanged.
    const statement = buildStatement(deps.config, deps.env, null, now);
    const key = canonicalJson({ ...statement, issuedAt: undefined, source: attestationSource(deps.env) });
    const cached = g.__relayAttestation;
    if (cached && cached.key === key && now - cached.at < ATTESTATION_CACHE_MS) return Response.json(cached.value, { headers: NO_STORE });
    g.__relayAttestationInflight ??= new Map();
    let pending = g.__relayAttestationInflight.get(key);
    if (!pending) {
      pending = attest(deps, null, statement).finally(() => g.__relayAttestationInflight?.delete(key));
      g.__relayAttestationInflight.set(key, pending);
    }
    const value = await pending;
    g.__relayAttestation = { key, at: now, value };
    return Response.json(value, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof NoTeeError) {
      const body: AttestationUnavailable = { error: "attestation unavailable", reason: "no-tee", hint: NO_TEE_HINT, detail: err.message };
      return Response.json(body, { status: 503, headers: NO_STORE });
    }
    console.error("[relay] attestation:", short(err));
    return Response.json({ error: "attestation failed", reason: "the attestation request failed" }, { status: 500, headers: NO_STORE });
  }
}
