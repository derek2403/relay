// Provider forwarding: where each provider lives, how the real key is
// injected, and the relay request handler itself. Providers come from the
// catalog (catalog.ts): upstream, auth kind, default headers and metering.
//
// A call to /api/relay/<provider>/<path> is checked (token -> ENS policy ->
// route rules), reserves its worst-case cost and count on every capped level,
// and is forwarded to <provider origin>/<path> with the company's key. The
// response streams back to the client while a copy of the body (tee) feeds the
// usage meter, so the charge settles when the provider finishes, whether or
// not the client reads the body. While it runs, the caller's chain is
// re-checked (live.ts): a name removed mid-stream is cut off within one
// interval.

import { type Address } from "viem";

import { tryNormalize } from "../ens/names";
import { type ProviderId, isProviderId } from "./bundle";
import { type Auth, CATALOG, type CatalogEntry, PROVIDER_IDS, answeredByRelay, catalogEntry } from "./catalog";
import { type CapUsage, codexCapUsage, codexLimitHeaders, usageLimitResponse } from "./codex-limits";
import { applyDnsAlias, upstreamEnvName } from "./config";
import { isChainReadError } from "./ens";
import { type LiveChecker, liveCheckerFor } from "./live";
import { type CallPlan, planCall, planImages } from "./plan";
import { type PolicyDecision, type PolicyDeps, REVOKED_ERROR, type Reservation, available, decide, reserve, spendLevels } from "./policy";
import { UsageTracker, type UsageFormat } from "./pricing";
import { type RelayLimits, clientKey, isKnownGood, markKnownGood, relayLimits } from "./ratelimit";
import { allowedRoutesText, pathSegments, routeDenial, routeFor } from "./routes";
import { TOKEN_PREFIX, TokenError, tokenFromHeaders, verifyToken } from "./token";
import type { LevelView, LogEntry, RelayError } from "./types";

// --- Provider table -------------------------------------------------------------

export type ProviderSpec = {
  id: ProviderId;
  entry: CatalogEntry;
  /** How to read token usage from responses; null when the provider isn't priced by tokens. */
  usage: UsageFormat | null;
  /** Sets the real key and the provider's default headers on the upstream request. */
  inject: (headers: Headers, key: string | null) => void;
};

/** Attaches the real key the way the provider expects it. */
export function injectAuth(headers: Headers, auth: Auth, key: string) {
  if (auth.kind === "bearer") headers.set("authorization", `Bearer ${key}`);
  else if (auth.kind === "header") headers.set(auth.name, key);
  else if (auth.kind === "raw-authorization") headers.set("authorization", key);
}

function specFor(entry: CatalogEntry): ProviderSpec {
  return {
    id: entry.id as ProviderId,
    entry,
    usage: entry.metering.kind === "tokens" ? entry.metering.format : null,
    inject: (headers, key) => {
      if (key) injectAuth(headers, entry.auth, key);
      // e.g. GitHub rejects requests without a User-Agent; Anthropic needs anthropic-version.
      for (const [name, value] of Object.entries(entry.defaultHeaders ?? {})) if (!headers.has(name)) headers.set(name, value);
    },
  };
}

export const PROVIDER_SPECS = Object.fromEntries(CATALOG.map((entry) => [entry.id, specFor(entry)])) as Record<ProviderId, ProviderSpec>;

const mockMetering = catalogEntry("mock").metering;
export const MOCK_COST_USD = mockMetering.kind === "requests" ? (mockMetering.usdPerRequest ?? 0) : 0;

/** Query parameters that carry a key for some providers (Gemini's ?key=); dropped so a client token never reaches them. */
const KEY_QUERY_PARAMS: Partial<Record<ProviderId, string[]>> = { gemini: ["key"] };
for (const entry of CATALOG) if (entry.auth.kind === "query") (KEY_QUERY_PARAMS[entry.id as ProviderId] ??= []).push(entry.auth.name);

/** The query string sent upstream, without key parameters. */
export function upstreamSearch(provider: ProviderId, url: URL): string {
  const drop = KEY_QUERY_PARAMS[provider];
  // In any case: OpenWeatherMap reads APPID as well as appid.
  const isKey = (name: string) => !!drop?.includes(name.toLowerCase());
  if (![...url.searchParams.keys()].some(isKey)) return url.search;
  const out = new URLSearchParams([...url.searchParams].filter(([name]) => !isKey(name))).toString();
  return out ? `?${out}` : "";
}

/** The agent token: x-api-key or Bearer, or where Gemini clients put a key (x-goog-api-key, ?key=). */
function requestToken(request: Request, url: URL, provider: ProviderId): string | null {
  const token = tokenFromHeaders(request.headers);
  if (token || provider !== "gemini") return token;
  const candidate = request.headers.get("x-goog-api-key")?.trim() || url.searchParams.get("key")?.trim() || "";
  return candidate.startsWith(`${TOKEN_PREFIX}.`) ? candidate : null;
}

// --- Paths ------------------------------------------------------------------------

export class PathError extends Error {}

// RFC 3986 pchar plus "%", checked again after decoding.
const SAFE_SEGMENT = /^[A-Za-z0-9\-._~!$&'()*+,;=:@%]+$/;

/**
 * Builds the upstream URL from the provider's fixed base, the raw
 * (still percent-encoded) path after /api/relay/<provider>, and the original
 * query string. Rejects anything that could leave the base: empty segments
 * ("//"), dot segments, encoded slashes/backslashes/dots, double encoding and
 * control characters.
 */
export function buildUpstreamUrl(base: string, rawPath: string, search = ""): URL {
  const baseUrl = new URL(base);
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  const segments: string[] = [];
  if (rawPath !== "" && rawPath !== "/") {
    if (!rawPath.startsWith("/")) throw new PathError("path must start with /");
    const parts = rawPath.slice(1).split("/");
    parts.forEach((seg, i) => {
      // A single trailing slash is fine ("/v1/models/"); empty segments elsewhere are not.
      if (seg === "" && i === parts.length - 1) return segments.push("");
      if (seg === "") throw new PathError("empty path segment");
      if (!SAFE_SEGMENT.test(seg)) throw new PathError("bad characters in path");
      let decoded: string;
      try {
        decoded = decodeURIComponent(seg);
      } catch {
        throw new PathError("bad percent-encoding in path");
      }
      if (decoded === "." || decoded === "..") throw new PathError("dot segments are not allowed");
      if (/[/\\%?#]/.test(decoded) || /[\u0000-\u001f\u007f]/.test(decoded)) throw new PathError("encoded separators are not allowed");
      segments.push(seg);
    });
  }
  const url = new URL(baseUrl.origin);
  url.pathname = segments.length ? `${basePath}/${segments.join("/")}` : basePath || "/";
  url.search = search;
  // Belt and braces: the result must still be on the provider's origin, under its base path.
  if (url.origin !== baseUrl.origin || !(url.pathname === basePath || url.pathname.startsWith(`${basePath}/`) || (!basePath && url.pathname === "/"))) {
    throw new PathError("path leaves the provider");
  }
  return url;
}

/** The raw path after /api/relay/<provider>, taken from the undecoded request URL. */
export function relayPathFromUrl(url: URL, provider: string): string {
  const prefix = `/api/relay/${provider}`;
  const raw = url.pathname;
  if (raw === prefix) return "";
  if (!raw.startsWith(`${prefix}/`)) throw new PathError("unexpected relay path");
  return raw.slice(prefix.length);
}

// --- Headers ----------------------------------------------------------------------

const DROP_REQUEST = new Set([
  "authorization",
  "x-api-key",
  // A Codex login's secret (codex-login.ts).
  "x-relay-login",
  "api-key",
  "cookie",
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "accept-encoding",
  "origin",
  "referer",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
]);
const DROP_REQUEST_PREFIXES = ["proxy-", "sec-", "x-middleware-", "x-invoke-", "x-nextjs-", "next-"];
// Every header a catalog provider takes its key in (e.g. x-goog-api-key): a client's own value never passes.
for (const entry of CATALOG) if (entry.auth.kind === "header") DROP_REQUEST.add(entry.auth.name.toLowerCase());

const DROP_RESPONSE = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
  "set-cookie2",
  // Details about the company's account that agents don't need.
  "anthropic-organization-id",
  "openai-organization",
  "openai-project",
  "x-oauth-scopes",
  "x-accepted-oauth-scopes",
  "x-oauth-client-id",
  "github-authentication-token-expiration",
  "x-github-sso",
]);

/**
 * Headers for the upstream request: the client's own credentials and
 * hop-by-hop headers are removed, compression is disabled so the meter can
 * read the body, the real key is injected and the provider's default headers
 * are added when missing. Everything else (anthropic-version, anthropic-beta,
 * openai-beta, content-type, ...) passes.
 */
export function upstreamRequestHeaders(incoming: Headers, spec: ProviderSpec, key: string | null): Headers {
  const listed = new Set((incoming.get("connection") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const out = new Headers();
  incoming.forEach((value, name) => {
    const n = name.toLowerCase();
    if (DROP_REQUEST.has(n) || listed.has(n) || DROP_REQUEST_PREFIXES.some((p) => n.startsWith(p))) return;
    out.set(n, value);
  });
  out.set("accept-encoding", "identity");
  spec.inject(out, key);
  return out;
}

/**
 * A redirect to the provider itself, rewritten to the same place through the
 * relay (a relative /api/relay/<provider>/... URL), so the client never sends
 * its token straight to the provider. Other origins pass unchanged; a
 * same-origin target outside the provider base can't be relayed and is dropped (null).
 */
export function relayLocation(location: string, upstreamUrl: URL, base: string, provider: string): string | null {
  let target: URL;
  try {
    target = new URL(location, upstreamUrl);
  } catch {
    return null;
  }
  const baseUrl = new URL(base);
  if (target.origin !== baseUrl.origin) return location;
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  if (basePath && target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`)) return null;
  return `/api/relay/${provider}${target.pathname.slice(basePath.length)}${target.search}${target.hash}`;
}

/**
 * Response headers passed back to the client: body framing, cookies and
 * account details are dropped, redirects to the provider go through the
 * relay, and the key is redacted from every value.
 */
export function clientResponseHeaders(
  upstream: Headers,
  opts: { secret?: string | null; provider?: string; base?: string; upstreamUrl?: URL } = {},
): Headers {
  const listed = new Set((upstream.get("connection") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const out = new Headers();
  upstream.forEach((value, name) => {
    const n = name.toLowerCase();
    if (DROP_RESPONSE.has(n) || listed.has(n)) return;
    let v: string | null = redactText(value, opts.secret ?? null);
    if (n === "location" && opts.provider && opts.base && opts.upstreamUrl) v = relayLocation(v, opts.upstreamUrl, opts.base, opts.provider);
    if (v !== null) out.append(n, v);
  });
  return out;
}

// --- Secret redaction -------------------------------------------------------------

export const redactText = (text: string, secret: string | null) =>
  secret && secret.length >= 8 ? text.split(secret).join("[redacted]") : text;

/**
 * Byte-level redactor for a streamed body: replaces any occurrence of the
 * key, even one split across chunks. It only holds back a chunk's tail while
 * that tail could be the start of the key, so streaming isn't delayed in
 * practice (SSE events end in "\n\n", which no key starts with).
 */
export function createRedactor(secret: string) {
  const needle = Buffer.from(secret);
  const replacement = Buffer.from("[redacted]");
  let held: Buffer = Buffer.alloc(0);
  const scan = (buf: Buffer, final: boolean): Uint8Array => {
    const parts: Buffer[] = [];
    let start = 0;
    let idx: number;
    while ((idx = buf.indexOf(needle, start)) !== -1) {
      parts.push(buf.subarray(start, idx), replacement);
      start = idx + needle.length;
    }
    let rest = buf.subarray(start);
    held = Buffer.alloc(0);
    if (!final) {
      for (let k = Math.min(needle.length - 1, rest.length); k > 0; k--) {
        if (rest.subarray(rest.length - k).equals(needle.subarray(0, k))) {
          held = Buffer.from(rest.subarray(rest.length - k));
          rest = rest.subarray(0, rest.length - k);
          break;
        }
      }
    }
    parts.push(rest);
    return new Uint8Array(Buffer.concat(parts));
  };
  return {
    push: (chunk: Uint8Array) => scan(Buffer.concat([held, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)]), false),
    end: () => (held.length ? scan(held, true) : new Uint8Array(0)),
  };
}

// --- Client stream ------------------------------------------------------------------

/** The final server-sent event a revoked stream ends with, in the provider's own error format. */
export function revokedEvent(provider: ProviderId, message: string): string {
  // Claude, and the mock (which answers like Claude), get Anthropic's error event.
  if (PROVIDER_SPECS[provider].usage === "anthropic" || provider === "mock") {
    return `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "permission_error", message } })}\n\n`;
  }
  // OpenAI Responses style; the top-level message/code also match OpenAI's own stream error event.
  const error = { type: "access_revoked", code: "access_revoked", message };
  return `event: error\ndata: ${JSON.stringify({ type: "error", code: "access_revoked", message, error })}\n\n`;
}

export type ClientStream = {
  stream: TransformStream<Uint8Array, Uint8Array>;
  /**
   * Ends the client's body early. With `final` (an SSE event) the body ends
   * cleanly with that event, sent at the next event boundary so the client
   * never sees half an event before it; without it (or when no boundary comes
   * in time) the body is aborted. Runs `after` once the body has ended.
   */
  kill: (final: string | null, after?: () => void) => void;
};

/** Index in `out` just past the first SSE event boundary ("\n\n", "\r\n\r\n", "\r\r") that ends inside `out`, or -1. */
function boundaryEnd(tail: string, out: Uint8Array): number {
  const s = tail + Buffer.from(out.buffer, out.byteOffset, out.byteLength).toString("latin1");
  const re = /\r\n\r\n|\n\n|\r\r/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const end = m.index + m[0].length - tail.length;
    if (end > 0) return end;
  }
  return -1;
}

const encoder = new TextEncoder();

/**
 * Passes the body to the client with the key redacted. `onEnd` runs when the
 * body has been passed on in full, `onCancel` when the client goes away or the
 * upstream body fails mid-way; neither runs after `kill`.
 */
export function clientStream(
  secret: string | null,
  hooks: { onEnd?: () => void; onCancel?: () => void } = {},
  boundaryWaitMs = 1000,
): ClientStream {
  const redactor = secret && secret.length >= 8 ? createRedactor(secret) : null;
  let controller: TransformStreamDefaultController<Uint8Array> | null = null;
  let done = false;
  /** The last few characters sent (latin1), to tell whether the client is between events. */
  let tail = "";
  let pending: { final: Uint8Array; after?: () => void; timer: ReturnType<typeof setTimeout> } | null = null;

  const sent = (bytes: Uint8Array) => {
    if (!bytes.byteLength) return;
    tail = (tail + Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).subarray(-4).toString("latin1")).slice(-4);
  };
  const atBoundary = () => tail === "" || /(\n\n|\r\n\r\n|\r\r)$/.test(tail);

  const endWith = (final: Uint8Array | null, after?: () => void) => {
    done = true;
    if (pending) clearTimeout(pending.timer);
    pending = null;
    try {
      if (final) {
        controller?.enqueue(final);
        controller?.terminate();
      } else {
        controller?.error(new Error("access revoked"));
      }
    } catch {
      // Already closed or errored.
    }
    after?.();
  };

  // `cancel` (readable side cancelled / writable side aborted) is in the Streams spec and Node >= 21,
  // but not yet in TypeScript's lib.dom Transformer type.
  const transformer = {
    start(c: TransformStreamDefaultController<Uint8Array>) {
      controller = c;
    },
    transform(chunk: Uint8Array, c: TransformStreamDefaultController<Uint8Array>) {
      if (done) return;
      const out = redactor ? redactor.push(chunk) : chunk;
      if (pending) {
        // A kill is waiting for the event in progress to finish: send the rest of it, then the final event.
        const cut = boundaryEnd(tail, out);
        if (cut >= 0) {
          const head = out.subarray(0, cut);
          if (head.byteLength) c.enqueue(head);
          sent(head);
          const p = pending;
          return endWith(p.final, p.after);
        }
      }
      if (out.byteLength) c.enqueue(out);
      sent(out);
    },
    flush(c: TransformStreamDefaultController<Uint8Array>) {
      if (done) return;
      done = true;
      if (redactor) {
        const rest = redactor.end();
        if (rest.byteLength) c.enqueue(rest);
      }
      const p = pending;
      if (p) clearTimeout(p.timer);
      pending = null;
      hooks.onEnd?.();
      p?.after?.();
    },
    cancel() {
      if (done) return;
      done = true;
      if (pending) clearTimeout(pending.timer);
      pending = null;
      hooks.onCancel?.();
    },
  };
  const stream = new TransformStream<Uint8Array, Uint8Array>(transformer);

  const kill = (final: string | null, after?: () => void) => {
    if (pending) return;
    if (done) {
      after?.();
      return;
    }
    const bytes = final ? encoder.encode(final) : null;
    if (!bytes || atBoundary()) return endWith(bytes, after);
    const timer = setTimeout(() => {
      const p = pending;
      if (p) endWith(null, p.after);
    }, boundaryWaitMs);
    timer.unref?.();
    pending = { final: bytes, after, timer };
  };
  return { stream, kill };
}

// --- Mock provider ----------------------------------------------------------------

export function mockMessage(name: string) {
  return {
    id: `msg_mock_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model: "mock",
    content: [{ type: "text", text: `Hello from the relay, ${name}` }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

/** The same message as Anthropic-style server-sent events, for clients that ask for stream: true. */
function mockSse(name: string): string {
  const m = mockMessage(name);
  const text = m.content[0].text;
  const events: [string, unknown][] = [
    ["message_start", { type: "message_start", message: { ...m, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

// --- Handler ----------------------------------------------------------------------

export type RelayDeps = PolicyDeps & {
  fetch?: typeof fetch;
  nowSec?: () => number;
  limits?: RelayLimits;
  /** How long an upstream call may run before the relay gives up on it. */
  upstreamTimeoutMs?: number;
  /** Re-checks names while their calls run (a checker on this deps.reader). Defaults to the shared one (RELAY_LIVE_CHECK_SEC); null turns it off. */
  live?: LiveChecker | null;
};

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_MOCK_BODY_BYTES = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 15 * 60_000;

/** Log reason for a call ended because its name was removed or expired while it ran. */
export const KILLED_REASON = "killed: access revoked";

const relayErrorResponse = (status: number, error: string, reason?: string, headers: Record<string, string> = {}) =>
  Response.json({ error, ...(reason ? { reason } : {}) } satisfies RelayError, { status, headers: { "cache-control": "no-store", ...headers } });

/** The relay's refusal in OpenAI's error shape, whose `error.message` Codex shows. */
export const openaiErrorResponse = (status: number, error: string, reason?: string, headers: Record<string, string> = {}) => {
  const code = error.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return Response.json(
    { error: { message: reason || error, type: code, code } },
    { status, headers: { "cache-control": "no-store", ...headers } },
  );
};

/** A caller the route has already authenticated (a Codex login session), used instead of a token from the request. */
export type RelayCaller = {
  name: string;
  /** Must still own `name` on ENS: checked on every call like a token's signer. */
  signer: Address;
  /** When the credential was issued (unix s), for relay.nbf. */
  issuedAt: number;
};

export type RelayCallOptions = {
  caller?: RelayCaller;
  /**
   * Answer the way Codex understands: refusals as OpenAI errors, and a spent codex cap as
   * 429 usage_limit_reached (which Codex shows without retrying).
   */
  codexClient?: boolean;
};

/** Reads the request body, stopping as soon as it passes `max` bytes (chunked uploads have no content-length). */
async function readBody(request: Request, max: number): Promise<Uint8Array | "too-large"> {
  if (Number(request.headers.get("content-length") ?? 0) > max) return "too-large";
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return "too-large";
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

function wantsStream(body: Uint8Array | null): boolean {
  if (!body?.byteLength) return false;
  try {
    return JSON.parse(new TextDecoder().decode(body))?.stream === true;
  } catch {
    return false;
  }
}

/** Connection errors that mean the request never reached the provider (nothing to charge). */
const NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
const neverSent = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return NOT_SENT.has(e?.cause?.code ?? e?.code ?? "");
};

class ClientGone extends Error {
  override name = "ClientGone";
}
class UpstreamTimeout extends Error {
  override name = "UpstreamTimeout";
}
class Revoked extends Error {
  override name = "Revoked";
}

const is2xx = (status: number) => status >= 200 && status < 300;

/**
 * Handles /api/relay/<provider>/<path>. Status codes: 401 missing/bad/expired
 * token, owner mismatch or revoked token, 403 policy or route denial, a
 * removed/expired level ("access revoked") or a name under review ("paused"), 404 unknown provider, 413 body too
 * large, 429 too many calls in flight or too many failed requests, 503
 * provider not configured, meter unavailable or root owner changed, 502
 * upstream or chain read failure.
 *
 * Charging: token-priced calls are charged from the provider's usage; image
 * and per-request calls count (and cost their catalog price) when the
 * provider answers 2xx. Failed calls don't count.
 *
 * Requests refused before the caller proves it owns a name are counted but
 * not logged, so anyone can't flush the log with junk.
 */
export async function handleRelayRequest(request: Request, providerParam: string, deps: RelayDeps, opts: RelayCallOptions = {}): Promise<Response> {
  const { config, meter } = deps;
  const errorResponse = opts.codexClient ? openaiErrorResponse : relayErrorResponse;
  const limits = deps.limits ?? relayLimits();
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const client = clientKey(request.headers);
  const now = deps.now?.() ?? new Date();
  let rawPath = "";
  let pathError: string | null = null;
  try {
    rawPath = relayPathFromUrl(url, providerParam);
  } catch (err) {
    pathError = err instanceof PathError ? err.message : "bad path";
  }

  const reject = (status: number, error: string, reason?: string, headers?: Record<string, string>) => {
    meter.countRejected();
    return errorResponse(status, error, reason, headers);
  };

  if (!isProviderId(providerParam)) {
    return reject(404, "unknown provider", `"${providerParam}" is not one of ${PROVIDER_IDS.join(", ")}`);
  }
  const provider: ProviderId = providerParam;
  const spec = PROVIDER_SPECS[provider];
  const entry = spec.entry;

  // 1. Token: signed by the agent's key, not expired, not too long-lived, for this relay.
  //    (A route that authenticated the caller itself passes it instead.)
  let signer: Address;
  let tokenName: string;
  let issuedAt: number;
  if (opts.caller) {
    const normalized = tryNormalize(opts.caller.name);
    if (!normalized) return reject(401, "bad token", "the caller's name is not a valid ENS name");
    ({ signer, issuedAt } = opts.caller);
    tokenName = normalized;
  } else {
    const token = requestToken(request, url, provider);
    if (!token) return reject(401, "missing token", "Send a Keyless Relay token (kr1...) as x-api-key or Authorization: Bearer.");
    try {
      const verified = await verifyToken(token, deps.nowSec?.(), { maxTtlSec: config.maxTokenTtlSec, audiences: config.audiences });
      signer = verified.signer;
      issuedAt = verified.payload.iat;
      const normalized = tryNormalize(verified.payload.name);
      if (!normalized) throw new TokenError("token names an invalid ENS name");
      tokenName = normalized;
    } catch (err) {
      const reason = err instanceof TokenError ? err.message : "bad token";
      return reject(401, reason.includes("expired") ? "token expired" : "bad token", reason);
    }
  }

  // 2. Unknown (name, signer) pairs cost chain reads; they share a failure budget per client.
  const pair = `${applyDnsAlias(tokenName, config.dnsAlias)}|${signer}`;
  const known = isKnownGood(limits, pair);
  if (!known && !limits.failures.has(client)) {
    return reject(429, "too many failed requests", "Too many refused requests from this address. Wait a minute and try again.", { "retry-after": "60" });
  }

  const log = (e: Partial<LogEntry> & Pick<LogEntry, "allowed" | "reason">) =>
    meter.log({ ts: Date.now(), name: null, provider, method, path: rawPath || "/", status: null, costUsd: null, estimated: false, signer, ...e });

  // 3. ENS policy for the token's own name, with the token's signer as the required owner.
  let decision: PolicyDecision;
  try {
    decision = await decide({ name: tokenName, provider, signer }, deps);
  } catch (err) {
    const reason = isChainReadError(err) ? err.message : "could not read ENS";
    if (known) log({ allowed: false, reason, name: tokenName });
    else meter.countRejected();
    return errorResponse(502, "ENS read failed", reason);
  }
  const name = decision.name;
  // "paused" comes after the chain checks: the caller owns a live name, so it is handled (and logged) below.
  if (decision.denial !== null && decision.denial !== "policy" && decision.denial !== "paused") {
    // The caller hasn't shown it owns a live name: log only pairs that recently did (e.g. a revoked session).
    if (known) log({ allowed: false, reason: decision.reason, name });
    else {
      meter.countRejected();
      if (decision.levels.length) limits.failures.spend(client);
    }
    const status = decision.denial === "not-owner" ? 401 : decision.denial === "root-mismatch" ? 503 : 403;
    const error =
      status === 401 ? "not the owner" : status === 503 ? "root owner changed" : decision.denial === "not-registered" ? REVOKED_ERROR : "denied";
    return errorResponse(status, error, decision.reason ?? "denied");
  }
  markKnownGood(limits, pair);

  // From here on the caller owns a live name: every outcome is logged.
  const leaf: LevelView = decision.levels[decision.levels.length - 1];
  // Codex shows its usage limit from these (codex-limits.ts): the cap that binds first, as of the last settled call.
  const capUsage: CapUsage | null = provider === "codex" ? codexCapUsage(decision, meter, now) : null;
  const limitHeaders = codexLimitHeaders(capUsage, Math.floor(now.getTime() / 1000));
  const refuse = (status: number, error: string, reason: string, headers?: Record<string, string>) => {
    log({ allowed: false, reason, name });
    return errorResponse(status, error, reason, { ...limitHeaders, ...headers });
  };
  /** A spent budget: Codex gets its usage-limit answer, everyone else the relay's 403. */
  const overBudget = (reason: string) => {
    if (!(opts.codexClient && provider === "codex")) return refuse(403, "denied", reason);
    log({ allowed: false, reason, name });
    // A spent count limit (requests) isn't the dollar cap the headers describe: Codex shows the reason itself.
    const countLimit = / limit \(|fewer than this call/.test(reason);
    return usageLimitResponse(countLimit ? null : capUsage, reason, Math.floor(now.getTime() / 1000));
  };
  if (leaf.nbf && issuedAt < leaf.nbf) {
    return refuse(401, "token revoked", `tokens for ${leaf.name} issued before ${new Date(leaf.nbf * 1000).toISOString()} are refused (relay.nbf); sign a new one`);
  }
  if (!decision.allowed) {
    if (decision.denial === "policy" && (decision.remaining === 0 || decision.remainingCount === 0)) return overBudget(decision.reason ?? "denied");
    return refuse(403, decision.denial === "paused" ? "paused" : "denied", decision.reason ?? "denied");
  }
  // The levels whose budgets this call spends: the chain's, plus any approved scope (overlay).
  const budgetLevels = spendLevels(decision);

  // 4. Provider, path and route. The mock (no upstream) is answered by the relay itself.
  if (entry.typedOnly) {
    return refuse(403, "denied", `the relay never forwards requests to ${entry.label} directly: agents use only the blockchain actions delegated to them`);
  }
  const local = answeredByRelay(entry);
  const segments = pathSegments(rawPath);
  const base = config.upstreams[provider];
  let upstreamUrl: URL | null = null;
  const route = routeFor(provider, method, segments, config.extraRoutes);
  if (!local) {
    if (!config.isConfigured(provider) || !base) {
      const why = !base ? `no valid upstream (check ${entry.upstreamEnv ?? upstreamEnvName(provider)})` : `no ${provider} key${entry.keyEnv ? ` (${entry.keyEnv})` : ""}`;
      return refuse(503, "provider not configured", `The relay has ${why}.`);
    }
    try {
      if (pathError) throw new PathError(pathError);
      upstreamUrl = buildUpstreamUrl(base, rawPath, upstreamSearch(provider, url));
    } catch (err) {
      return refuse(400, "bad path", err instanceof PathError ? err.message : "bad path");
    }
  }
  if (!route) {
    return refuse(403, "denied", `the relay doesn't forward ${method} /${segments.join("/")} to ${provider}; allowed: ${allowedRoutesText(provider, config.extraRoutes)}`);
  }
  // Calls that cost money or are capped need a working meter; free, uncapped ones don't.
  const capped = budgetLevels.some((l) => l.bundle?.caps[provider] !== undefined || l.bundle?.maxes?.[provider] !== undefined);
  if (route.kind !== "free" && (entry.dollarCaps || capped)) {
    const why = meter.unavailable();
    if (why) return refuse(503, "meter unavailable", `${why}. Metered calls are refused until spend can be recorded.`);
  }

  // 5. One slot per call in flight for this name.
  const slot = `${name}|${leaf.resource ?? "0"}`;
  if (!meter.enter(slot, config.maxConcurrent)) {
    return refuse(429, "too many calls", `${name} already has ${config.maxConcurrent} calls in flight`, { "retry-after": "2" });
  }
  let inSlot = true;
  const leave = () => {
    if (inSlot) {
      inSlot = false;
      meter.leave(slot);
    }
  };
  const refuseAndLeave = (status: number, error: string, reason: string) => {
    leave();
    return refuse(status, error, reason);
  };
  const overBudgetAndLeave = (reason: string) => {
    leave();
    return overBudget(reason);
  };

  let body: Uint8Array | null = null;
  if (method !== "GET" && method !== "HEAD") {
    const max = local ? MAX_MOCK_BODY_BYTES : MAX_BODY_BYTES;
    let read: Uint8Array | "too-large";
    try {
      read = await readBody(request, max);
    } catch {
      return refuseAndLeave(400, "bad request", "the request body could not be read");
    }
    if (read === "too-large") return refuseAndLeave(413, "request too large", `The relay forwards bodies up to ${max / 1024 / 1024} MB.`);
    body = read;
  }

  const filtered = routeDenial(provider, method, segments, body);
  if (filtered) return refuseAndLeave(403, "denied", filtered);

  // 6. What the call may cost and count, reserved on every level before it is sent.
  let plan: CallPlan | null = null;
  let usd = 0;
  let count = 0;
  let streaming = wantsStream(body);
  if (route.kind === "images") {
    const images = await planImages(body, request.headers.get("content-type"));
    if (!images.ok) return refuseAndLeave(images.status, images.error, images.reason);
    count = images.n;
    streaming = images.streaming;
    usd = entry.metering.kind === "images" ? images.n * entry.metering.usdPerImage : 0;
  } else if (route.kind === "request") {
    count = 1;
    usd = entry.metering.kind === "requests" ? (entry.metering.usdPerRequest ?? 0) : 0;
  }
  // No await from here to the reservation: the budget read and the hold happen together.
  if (route.kind === "generate" || route.kind === "embed") {
    const planned = planCall({
      provider,
      kind: route.kind,
      api: route.api,
      body,
      available: available(budgetLevels, provider, meter, now),
      maxOutputTokens: config.maxOutputTokens,
      codexPrices: config.codexPrices,
    });
    // A 403 here means the budget left can't pay for the call.
    if (!planned.ok) return planned.status === 403 ? overBudgetAndLeave(planned.reason) : refuseAndLeave(planned.status, planned.error, planned.reason);
    plan = planned.plan;
    body = plan.body;
    streaming = plan.streaming;
    usd = plan.worstUsd;
    count = 1;
  }
  let reservation: Reservation | null = null;
  if (usd > 0 || count > 0) {
    const held = reserve(budgetLevels, provider, usd, meter, now, count);
    if (!held.ok) return overBudgetAndLeave(held.reason);
    reservation = held.reservation;
  }

  // Mock: the relay answers itself and charges its catalog price, up front.
  if (local) {
    reservation?.settle(usd, count);
    leave();
    log({ allowed: true, reason: null, name, status: 200, costUsd: usd });
    return new Response(streaming ? mockSse(name) : JSON.stringify(mockMessage(name)), {
      status: 200,
      headers: { "content-type": streaming ? "text/event-stream" : "application/json", "cache-control": "no-store" },
    });
  }

  // 7. Forward with the real key.
  const key = config.keyFor(provider);
  // Query-parameter auth (OpenWeatherMap's ?appid=): the client's own copy was dropped by upstreamSearch.
  if (key && upstreamUrl && entry.auth.kind === "query") upstreamUrl.searchParams.set(entry.auth.name, key);
  const tokenPriced = !!plan && plan.kind !== "free";
  // A client that leaves stops a stream (the provider stops generating). A non-streamed generation
  // keeps running to the end, since the provider bills it anyway, and is charged from its real usage.
  const billedAnyway = (tokenPriced || route.kind === "images") && !streaming;
  const upstreamAbort = new AbortController();
  const timer = setTimeout(() => upstreamAbort.abort(new UpstreamTimeout("upstream timed out")), deps.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS);
  timer.unref?.();
  let clientGone = false;
  const onClientGone = () => {
    clientGone = true;
    if (!billedAnyway) upstreamAbort.abort(new ClientGone("client disconnected"));
  };
  if (request.signal.aborted) onClientGone();
  else request.signal.addEventListener("abort", onClientGone, { once: true });

  // Live kill: while the call runs, the name's chain is re-checked. Before the response arrives a
  // revocation aborts the upstream call; once it streams, killClient ends the client's body first.
  let killClient: ((reason: string) => void) | null = null;
  let revokedWith: string | null = null;
  const live = deps.live === undefined ? liveCheckerFor(deps.reader, config.liveCheckMs) : deps.live;
  const unwatch = live
    ? live.watch({ root: config.rootName!, name, signer }, (reason) => {
        revokedWith = reason;
        if (killClient) killClient(reason);
        else upstreamAbort.abort(new Revoked(reason));
      })
    : () => {};

  let settled = false;
  const finish = (r: { status: number | null; usd: number; count: number; estimated: boolean; reason: string | null }) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    unwatch();
    request.signal.removeEventListener("abort", onClientGone);
    reservation?.settle(r.usd, r.count);
    leave();
    log({ allowed: true, reason: r.reason, name, status: r.status, costUsd: r.usd, estimated: r.estimated });
  };
  const endReason = () => {
    const why = upstreamAbort.signal.reason;
    if (revokedWith || why instanceof Revoked) return KILLED_REASON;
    if (why instanceof UpstreamTimeout) return "upstream timed out";
    return clientGone ? "client disconnected" : "stream ended early";
  };

  if (clientGone) {
    // Gone before anything was sent: nothing to charge.
    finish({ status: null, usd: 0, count: 0, estimated: false, reason: "client disconnected before the call was sent" });
    return errorResponse(502, "client disconnected");
  }

  let upstream: Response;
  try {
    upstream = await (deps.fetch ?? fetch)(upstreamUrl!, {
      method,
      headers: upstreamRequestHeaders(request.headers, spec, key),
      body: body && body.byteLength ? (body as Uint8Array<ArrayBuffer>) : undefined,
      redirect: "manual",
      cache: "no-store",
      signal: upstreamAbort.signal,
    });
  } catch (err) {
    // Once a token-priced request may have reached the provider, it is charged: a stream its
    // estimated input, anything else its worst case (the provider usually finishes and bills it).
    // Image and per-request calls only count on a 2xx answer, which never came.
    const spent = !tokenPriced || neverSent(err) ? 0 : plan!.streaming ? plan!.floorUsd : plan!.worstUsd;
    const why = upstreamAbort.signal.aborted ? endReason() : err instanceof Error ? err.message : String(err);
    finish({ status: null, usd: spent, count: 0, estimated: spent > 0, reason: redactText(why === KILLED_REASON ? why : `could not reach ${provider}: ${why}`, key) });
    if (why === KILLED_REASON) return errorResponse(403, REVOKED_ERROR, revokedWith ?? KILLED_REASON);
    return errorResponse(502, "upstream error", redactText(`could not reach ${provider}: ${why}`, key));
  }

  const status = upstream.status;
  const headers = clientResponseHeaders(upstream.headers, { secret: key, provider, base: base!, upstreamUrl: upstreamUrl! });
  if (provider === "codex") {
    // Only the relay's numbers: the company account's own usage headers (if any) never reach the agent.
    for (const n of [...headers.keys()]) if (n.startsWith("x-codex-")) headers.delete(n);
    for (const [n, v] of Object.entries(limitHeaders)) headers.set(n, v);
  }
  const tracker =
    tokenPriced && spec.usage
      ? new UsageTracker(spec.usage, upstream.headers.get("content-type"), {
          requestModel: plan!.model,
          codexPrices: config.codexPrices,
          requestInputTokens: plan!.inputTokens,
          worstCaseUsd: plan!.worstUsd,
        })
      : null;
  const settleFrom = (aborted: boolean) => {
    const reason = aborted ? endReason() : null;
    if (tracker) {
      const r = tracker.finish({ aborted, status });
      finish({ status, usd: r.usd, count: is2xx(status) ? count : 0, estimated: r.estimated, reason });
    } else {
      // Image and per-request calls cost their fixed price, counted only on success.
      const ok = is2xx(status);
      finish({ status, usd: ok ? usd : 0, count: ok ? count : 0, estimated: false, reason });
    }
  };

  if (!upstream.body) {
    settleFrom(false);
    return new Response(null, { status, statusText: upstream.statusText, headers });
  }
  const sse = (upstream.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
  const toClient = (hooks: { onEnd?: () => void; onCancel?: () => void }) => {
    const out = clientStream(key, hooks);
    // Revoked mid-stream: an SSE body ends with the provider's error event, anything else is aborted.
    // Then the upstream call is stopped and what was used so far is charged.
    killClient = (reason) =>
      out.kill(sse ? revokedEvent(provider, reason) : null, () => {
        upstreamAbort.abort(new Revoked(reason));
        if (!tracker) settleFrom(true);
      });
    return out.stream;
  };

  if (tracker) {
    // The meter reads its own copy of the body to the end, so the charge doesn't wait for the client.
    const [forClient, forMeter] = upstream.body.tee();
    void (async () => {
      const reader = forMeter.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          tracker.push(value);
        }
        settleFrom(false);
      } catch {
        settleFrom(true);
      }
    })();
    return new Response(forClient.pipeThrough(toClient({ onCancel: onClientGone })), { status, statusText: upstream.statusText, headers });
  }
  return new Response(
    upstream.body.pipeThrough(
      toClient({
        onEnd: () => settleFrom(false),
        onCancel: () => {
          onClientGone();
          settleFrom(true);
        },
      }),
    ),
    { status, statusText: upstream.statusText, headers },
  );
}
