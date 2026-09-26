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
//
// With RELAY_ATTESTATION_URL (an attestation service in a dstack CVM on Phala
// Cloud) the relay instead forwards a nonce to <url>/attestation, reads the
// service's /info, and asks Phala's public verifier about the quote. Every call
// is fresh (the browser sends a new nonce), rate limited, and refused (502) when
// the quote doesn't carry the nonce.

import { randomBytes } from "node:crypto";

import { type RelayConfig, getConfig, parseBaseUrl } from "./config";
import { CATALOG } from "./catalog";
import {
  type AttestationInfo,
  type AttestationResponse,
  type AttestationStatement,
  type AttestationUnavailable,
  type IntelVerification,
  PHALA_VERIFY_API,
  PHALA_VERIFY_URL,
  type RemoteAttestationResponse,
  canonicalJson,
  fromHex,
  parseNonce,
  parseTdxQuote,
  phalaReportUrl,
  remoteChecks,
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
  /** RELAY_ATTESTATION_URL: take quotes from this attestation service instead of dstack. */
  remoteUrl?: string | null;
  /** Phala's verifier API (tests point it elsewhere); null skips it. */
  verifierUrl?: string | null;
  fetch?: typeof fetch;
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

// --- Remote attestation service ---------------------------------------------------------------------

export const REMOTE_TIMEOUT_MS = 20_000;
const INFO_CACHE_MS = 60_000;

/** The service or its quote isn't usable (answered 502). */
export class RemoteAttestationError extends Error {
  override name = "RemoteAttestationError";
}

async function getJson(f: typeof fetch, url: string, init: RequestInit, ms: number, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await f(url, { ...init, signal: AbortSignal.timeout(ms), cache: "no-store" });
  } catch (err) {
    throw new RemoteAttestationError(`${what} didn't answer: ${short(err)}`);
  }
  if (!res.ok) throw new RemoteAttestationError(`${what} answered HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new RemoteAttestationError(`${what} didn't answer with JSON`);
  }
}

const isHex = (v: unknown): v is string => typeof v === "string" && /^(0x)?[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0;

/** The image the service's compose file runs (dstack puts the compose file in tcb_info.app_compose). */
export function composeImage(appCompose: unknown): string | undefined {
  if (typeof appCompose !== "string") return undefined;
  try {
    const file = (JSON.parse(appCompose) as { docker_compose_file?: unknown }).docker_compose_file;
    return typeof file === "string" ? file.match(/^\s*image:\s*["']?([^\s"'#]+)/m)?.[1] : undefined;
  } catch {
    return undefined;
  }
}

/** The service's /info, trimmed to the identity fields (cached for a minute per URL). */
async function serviceInfo(deps: AttestationDeps, base: string): Promise<RemoteAttestationResponse["service"]> {
  const now = deps.now?.() ?? Date.now();
  const hit = g.__relayServiceInfo?.get(base);
  if (hit && now - hit.at < INFO_CACHE_MS) return hit.value;
  const r = (await getJson(deps.fetch ?? fetch, `${base}/info`, {}, deps.timeoutMs ?? REMOTE_TIMEOUT_MS, "the attestation service's /info")) as Record<string, unknown>;
  const tcb = (r.tcb_info && typeof r.tcb_info === "object" ? r.tcb_info : {}) as Record<string, unknown>;
  const value: RemoteAttestationResponse["service"] = { url: base };
  const set = (k: keyof typeof value, v: unknown) => {
    if (typeof v === "string" && v) (value as Record<string, string>)[k] = v.slice(0, 300);
  };
  set("appId", r.app_id);
  set("instanceId", r.instance_id);
  set("composeHash", isHex(r.compose_hash) ? strip0x(r.compose_hash) : tcb.compose_hash);
  set("osImageHash", r.os_image_hash ?? tcb.os_image_hash);
  set("image", composeImage(tcb.app_compose));
  (g.__relayServiceInfo ??= new Map()).set(base, { at: now, value });
  return value;
}

/** Phala's public verifier on the quote. Never throws: an unanswered check is reported, not fatal. */
export async function verifyWithPhala(deps: AttestationDeps, quote: string, reportData: string): Promise<IntelVerification | null> {
  const url = deps.verifierUrl === undefined ? PHALA_VERIFY_API : deps.verifierUrl;
  if (!url) return null;
  try {
    const r = (await getJson(
      deps.fetch ?? fetch,
      url,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hex: quote }) },
      deps.timeoutMs ?? REMOTE_TIMEOUT_MS,
      "Phala's verifier",
    )) as { success?: unknown; checksum?: unknown; id?: unknown; verified_at?: unknown; quote?: { verified?: unknown; body?: { reportdata?: unknown } } };
    const checksum = typeof r.checksum === "string" ? r.checksum : typeof r.id === "string" ? r.id : null;
    const seen = typeof r.quote?.body?.reportdata === "string" ? strip0x(r.quote.body.reportdata) : null;
    // The verdict counts only for this quote: the verifier must have read our REPORTDATA.
    const sameQuote = seen === reportData;
    const verified = r.success === true && r.quote?.verified === true && sameQuote;
    return {
      verified,
      checksum,
      reportUrl: checksum ? phalaReportUrl(checksum) : null,
      verifiedAt: typeof r.verified_at === "string" ? r.verified_at : null,
      ...(verified ? {} : { error: !sameQuote ? "the verifier's answer is for a different quote" : "the verifier rejected the quote" }),
    };
  } catch (err) {
    return { verified: false, checksum: null, reportUrl: null, verifiedAt: null, error: short(err) };
  }
}

/** A fresh quote from the attestation service for `nonce`, with its identity and Phala's verdict. */
export async function attestRemote(deps: AttestationDeps, base: string, nonce: string): Promise<RemoteAttestationResponse> {
  const f = deps.fetch ?? fetch;
  const ms = deps.timeoutMs ?? REMOTE_TIMEOUT_MS;
  const infoP = serviceInfo(deps, base);
  infoP.catch(() => undefined);
  const got = (await getJson(f, `${base}/attestation?nonce=${nonce}`, {}, ms, "the attestation service")) as { quote?: unknown };
  if (!isHex(got.quote)) throw new RemoteAttestationError("the attestation service returned no quote");
  const quote = strip0x(got.quote);
  const measurements = parseTdxQuote(quote);
  if (!measurements) throw new RemoteAttestationError("the attestation service returned something that isn't a TDX quote");
  // Its own report_data field is just a claim; what counts is REPORTDATA inside the quote.
  if (!remoteChecks(quote, nonce, null).nonceInQuote) throw new RemoteAttestationError("the attestation service's quote doesn't carry this request's nonce");
  const [service, intel] = await Promise.all([infoP, verifyWithPhala(deps, quote, measurements.reportData)]);
  return {
    source: "remote",
    service,
    nonce,
    quote,
    measurements,
    intel,
    verifyUrl: intel?.reportUrl ?? PHALA_VERIFY_URL,
    fetchedAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
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
  const remote = (process.env.RELAY_ATTESTATION_URL ?? "").trim();
  return { config: getConfig(), env: process.env, quoter: () => dstackQuoter(process.env), remoteUrl: remote ? parseBaseUrl(remote) : null };
}

// --- Handler --------------------------------------------------------------------------------------------

type Cached = { key: string; at: number; value: AttestationResponse };
const g = globalThis as unknown as {
  __relayServiceInfo?: Map<string, { at: number; value: RemoteAttestationResponse["service"] }>;
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
  g.__relayServiceInfo = undefined;
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
  if (deps.remoteUrl !== undefined && deps.remoteUrl !== null) {
    // Every remote quote is fresh: a caller without a nonce gets one made here.
    if (!limit.take(clientKey(request.headers))) return Response.json({ error: "too many attestation requests", reason: "Wait a few seconds and try again." }, { status: 429, headers: { ...NO_STORE, "retry-after": "5" } });
    try {
      return Response.json(await attestRemote(deps, deps.remoteUrl, nonce ?? randomBytes(32).toString("hex")), { headers: NO_STORE });
    } catch (err) {
      const reason = err instanceof RemoteAttestationError ? err.message : "the attestation request failed";
      if (!(err instanceof RemoteAttestationError)) console.error("[relay] attestation:", short(err));
      return Response.json({ error: "attestation service unavailable", reason }, { status: 502, headers: NO_STORE });
    }
  }
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
