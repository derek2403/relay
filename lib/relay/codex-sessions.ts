// Codex logins (see codex-login.ts): the store, registration and revocation
// (POST/DELETE /api/relay/codex/sessions), and the Codex provider route for a
// login (/api/relay/codex/login/v1/... with the secret in x-relay-login).
//
// Stored in <RELAY_DATA_DIR>/codex-sessions.json by the hash of the secret:
// { agent, member, signer, iat, exp }. Kept in memory and written
// synchronously (tmp file, fsync, rename, mode 0600) before an answer is
// sent. A file that exists but can't be read makes every login fail closed
// and is never saved over. SINGLE INSTANCE ONLY, like the meter.
//
// A call through a login is served exactly like a kr1 call from the agent
// (handleRelayRequest with the stored signer as the caller): the signer must
// still own the agent name on ENS, every level above must be registered, and
// relay.nbf, caps, metering, the log, route rules and live revocation all
// apply. The login only replaces the token: the Bearer value Codex sends
// must be the member's (or agent's) ENS name the session was made for.
// Failed lookups share the relay's failure budget per client. The secret is
// never logged: the relay handles the call under /api/relay/codex/v1/...

import fs from "node:fs";
import path from "node:path";

import { type Address, type Hex, isAddressEqual, isHex, recoverMessageAddress } from "viem";

import { tryNormalize } from "../ens/names";
import { applyDnsAlias } from "./config";
import {
  CODEX_LOGIN_HEADER,
  CODEX_LOGIN_PATH,
  CODEX_LOGIN_SKEW_SEC,
  LOGIN_SECRET,
  MAX_CODEX_LOGIN_SEC,
  codexLoginMessage,
  codexLogoutMessage,
  loginSecretHash,
} from "./codex-login";
import { isChainReadError } from "./ens";
import { REVOKED_ERROR, decide, relayDeps } from "./policy";
import { type RelayDeps, handleRelayRequest, openaiErrorResponse } from "./providers";
import { clientKey, relayLimits } from "./ratelimit";

export const CODEX_SESSIONS_FILE = "codex-sessions.json";
/** Logins kept per agent (a new `relay login` usually revokes the last one; this bounds the rest). */
const MAX_PER_AGENT = 5;
const MAX_SESSIONS = 10_000;
const MAX_BODY = 4096;

export type CodexSession = { agent: string; member: string; signer: Address; iat: number; exp: number; createdAt: number };
type StoreData = { v: 1; sessions: Record<string, CodexSession> };

const nowSecOf = (deps: Pick<RelayDeps, "now">) => Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);

export class CodexSessionStore {
  data: StoreData = { v: 1, sessions: {} };
  /** Set when the file exists but can't be read: nothing is saved over it. */
  readonly broken: string | null;

  constructor(readonly file: string) {
    this.broken = this.load();
  }

  private load(): string | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      return `${this.file} can't be read (${(err as Error).message})`;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoreData>;
      if (!parsed || parsed.v !== 1 || !parsed.sessions || typeof parsed.sessions !== "object" || Array.isArray(parsed.sessions)) {
        throw new Error("not a version 1 Codex sessions file");
      }
      this.data = { v: 1, sessions: parsed.sessions };
      return null;
    } catch (err) {
      return `${this.file} is damaged (${err instanceof Error ? err.message : String(err)}). Restore it or move it aside, then restart the relay.`;
    }
  }

  /**
   * Why logins must fail closed right now, or null. A failed save isn't a reason: the change is rolled
   * back (memory matches the file), that request fails, and the next change tries to save again.
   */
  unavailable(): string | null {
    return this.broken;
  }

  /** The live session for a secret hash, or null (unknown, revoked or expired). */
  get(hash: string, nowSec: number): CodexSession | null {
    const s = Object.hasOwn(this.data.sessions, hash) ? this.data.sessions[hash] : undefined;
    return s && s.exp > nowSec ? s : null;
  }

  add(hash: string, session: CodexSession, nowSec: number) {
    this.commit((d) => {
      d.sessions[hash] = session;
      this.prune(d, nowSec);
    });
  }

  /** True when the hash named a stored session (expired ones too). */
  revoke(hash: string, nowSec: number): boolean {
    if (!Object.hasOwn(this.data.sessions, hash)) return false;
    this.commit((d) => {
      delete d.sessions[hash];
      this.prune(d, nowSec);
    });
    return true;
  }

  private prune(d: StoreData, nowSec: number) {
    const entries = Object.entries(d.sessions).filter(([, s]) => s.exp > nowSec);
    entries.sort(([, a], [, b]) => b.createdAt - a.createdAt);
    const perAgent = new Map<string, number>();
    const kept: [string, CodexSession][] = [];
    for (const e of entries) {
      const n = (perAgent.get(e[1].agent) ?? 0) + 1;
      perAgent.set(e[1].agent, n);
      if (n <= MAX_PER_AGENT && kept.length < MAX_SESSIONS) kept.push(e);
    }
    d.sessions = Object.fromEntries(kept);
  }

  private commit(fn: (d: StoreData) => void) {
    if (this.broken) throw new Error(this.broken);
    const before = structuredClone(this.data);
    try {
      fn(this.data);
      this.save();
    } catch (err) {
      this.data = before;
      throw err;
    }
  }

  private save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const fd = fs.openSync(tmp, "w", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(this.data));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`Codex sessions store unavailable: can't save ${this.file} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
}

// One store per file, on globalThis so every bundle and dev-server reload shares it.
const g = globalThis as unknown as { __relayCodexSessions?: Map<string, CodexSessionStore> };

export function getCodexSessionStore(dataDir: string): CodexSessionStore {
  const file = path.resolve(dataDir, CODEX_SESSIONS_FILE);
  g.__relayCodexSessions ??= new Map();
  let store = g.__relayCodexSessions.get(file);
  if (!store) {
    store = new CodexSessionStore(file);
    g.__relayCodexSessions.set(file, store);
  }
  return store;
}

export type CodexSessionDeps = RelayDeps & { sessions: CodexSessionStore };

export function codexSessionDeps(): CodexSessionDeps {
  const deps = relayDeps();
  return { ...deps, sessions: getCodexSessionStore(deps.config.dataDir) };
}

// --- Registration and revocation ---------------------------------------------------------------

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
const fail = (status: number, error: string, reason: string, headers: Record<string, string> = {}) => json(status, { error, reason }, headers);

class BadRequest extends Error {}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) throw new BadRequest("body too large");
  const text = await request.text();
  if (text.length > MAX_BODY) throw new BadRequest("body too large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BadRequest("body is not JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequest("body must be a JSON object");
  return body as Record<string, unknown>;
}

const str = (b: Record<string, unknown>, k: string) => {
  const v = b[k];
  if (typeof v !== "string" || !v.trim()) throw new BadRequest(`${k} is missing`);
  return v.trim();
};
const int = (b: Record<string, unknown>, k: string) => {
  const v = b[k];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) throw new BadRequest(`${k} must be unix seconds`);
  return v;
};
const hashOf = (b: Record<string, unknown>) => {
  const v = str(b, "secretHash").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(v)) throw new BadRequest("secretHash must be a sha256 hex digest");
  return v as Hex;
};
const signatureOf = (b: Record<string, unknown>) => {
  const v = str(b, "signature");
  if (!isHex(v)) throw new BadRequest("signature must be hex");
  return v;
};

/** The claimed relay origin, when it is one this relay answers to (like a token's audience). */
function relayOf(b: Record<string, unknown>, deps: RelayDeps): string {
  const raw = str(b, "relay");
  let origin: string;
  try {
    origin = new URL(raw).origin;
  } catch {
    throw new BadRequest("relay must be the relay's origin");
  }
  if (!deps.config.audiences.includes(origin)) throw new BadRequest(`this login is for ${origin}, not this relay`);
  return origin;
}

function freshIat(iat: number, nowSec: number) {
  if (Math.abs(iat - nowSec) > CODEX_LOGIN_SKEW_SEC) throw new BadRequest("issued is too far from the relay's clock; check your computer's time and try again");
}

function nameOf(b: Record<string, unknown>, k: string, deps: RelayDeps): string {
  const raw = str(b, k);
  const n = tryNormalize(raw);
  if (!n || !n.includes(".")) throw new BadRequest(`${k} "${raw.slice(0, 80)}" is not a valid ENS name`);
  return applyDnsAlias(n, deps.config.dnsAlias);
}

/**
 * POST /api/relay/codex/sessions {agent, member, relay, secretHash, iat, exp, signature}: registers a
 * Codex login signed by the agent's key (codexLoginMessage). 201 {agent, member, exp}; 400 a bad or
 * too-long claim, or a member that isn't the agent's parent; 401 a signer that doesn't own the agent;
 * 403 a removed level; 409 a secret hash another login holds; 429 too many failures; 502 ENS unreadable;
 * 503 store unavailable.
 */
export async function postCodexSession(request: Request, deps: CodexSessionDeps): Promise<Response> {
  const limits = deps.limits ?? relayLimits();
  const client = clientKey(request.headers);
  if (!limits.failures.has(client)) return fail(429, "too many failed requests", "Wait a minute and try again.", { "retry-after": "60" });
  const nowSec = nowSecOf(deps);
  let claim: { agent: string; member: string; relay: string; secretHash: Hex; iat: number; exp: number };
  let signature: Hex;
  try {
    const b = await readJsonBody(request);
    claim = { agent: nameOf(b, "agent", deps), member: nameOf(b, "member", deps), relay: relayOf(b, deps), secretHash: hashOf(b), iat: int(b, "iat"), exp: int(b, "exp") };
    signature = signatureOf(b);
    freshIat(claim.iat, nowSec);
    // The typed name is the agent's own member (its parent), never a name further up such as the company's.
    if (claim.agent.slice(claim.agent.indexOf(".") + 1) !== claim.member) throw new BadRequest(`${claim.agent} is not an agent of ${claim.member}`);
    if (claim.exp <= nowSec) throw new BadRequest("the login has already expired");
    const longest = Math.min(MAX_CODEX_LOGIN_SEC, deps.config.maxTokenTtlSec);
    if (claim.exp - nowSec > longest) throw new BadRequest(`a Codex login lasts at most ${Math.round(longest / 3600)} h; sign a shorter one`);
  } catch (err) {
    if (err instanceof BadRequest) return fail(400, "bad request", err.message);
    throw err;
  }

  let signer: Address;
  try {
    signer = await recoverMessageAddress({ message: codexLoginMessage(claim), signature });
  } catch {
    limits.failures.spend(client);
    return fail(401, "bad signature", "the signature doesn't match the login");
  }
  let decision: Awaited<ReturnType<typeof decide>>;
  try {
    decision = await decide({ name: claim.agent, provider: null, signer }, deps);
  } catch (err) {
    if (isChainReadError(err)) return fail(502, "ENS read failed", err.message);
    throw err;
  }
  // With no provider, a chain that checks out ends in "unknown-provider".
  if (decision.denial !== "unknown-provider") {
    limits.failures.spend(client);
    if (decision.denial === "not-registered") return fail(403, REVOKED_ERROR, decision.reason ?? REVOKED_ERROR);
    if (decision.denial === "root-mismatch") return fail(503, "root owner changed", decision.reason ?? "root owner changed");
    return fail(401, "not the owner", decision.reason ?? `${signer} doesn't own ${claim.agent}`);
  }
  const leaf = decision.levels[decision.levels.length - 1];
  if (leaf.expiry && claim.exp > leaf.expiry) {
    return fail(400, "bad request", `the login would outlast ${claim.agent}, which expires at ${new Date(leaf.expiry * 1000).toISOString()}`);
  }
  if (leaf.nbf && claim.iat < leaf.nbf) return fail(401, "token revoked", `logins for ${claim.agent} issued before ${new Date(leaf.nbf * 1000).toISOString()} are refused`);

  const why = deps.sessions.unavailable();
  if (why) return fail(503, "sessions unavailable", why);
  // A secret hash names one login: another key or agent can never take over (or re-point) one it didn't make.
  const held = Object.hasOwn(deps.sessions.data.sessions, claim.secretHash) ? deps.sessions.data.sessions[claim.secretHash] : null;
  if (held && !(isAddressEqual(held.signer, signer) && held.agent === claim.agent && held.member === claim.member)) {
    limits.failures.spend(client);
    return fail(409, "login exists", "this secret already belongs to another login; run relay login again for a new one");
  }
  try {
    deps.sessions.add(claim.secretHash, { agent: claim.agent, member: claim.member, signer, iat: claim.iat, exp: claim.exp, createdAt: nowSec }, nowSec);
  } catch (err) {
    return fail(503, "sessions unavailable", err instanceof Error ? err.message : String(err));
  }
  return json(201, { agent: claim.agent, member: claim.member, exp: claim.exp });
}

/**
 * DELETE /api/relay/codex/sessions {relay, secretHash, iat, signature}: revokes a login, signed by the
 * key that registered it (codexLogoutMessage). 200 {revoked: true|false}; false when there was none.
 */
export async function deleteCodexSession(request: Request, deps: CodexSessionDeps): Promise<Response> {
  const limits = deps.limits ?? relayLimits();
  const client = clientKey(request.headers);
  if (!limits.failures.has(client)) return fail(429, "too many failed requests", "Wait a minute and try again.", { "retry-after": "60" });
  const nowSec = nowSecOf(deps);
  let claim: { relay: string; secretHash: Hex; iat: number };
  let signature: Hex;
  try {
    const b = await readJsonBody(request);
    claim = { relay: relayOf(b, deps), secretHash: hashOf(b), iat: int(b, "iat") };
    signature = signatureOf(b);
    freshIat(claim.iat, nowSec);
  } catch (err) {
    if (err instanceof BadRequest) return fail(400, "bad request", err.message);
    throw err;
  }
  const session = Object.hasOwn(deps.sessions.data.sessions, claim.secretHash) ? deps.sessions.data.sessions[claim.secretHash] : null;
  if (!session) return json(200, { revoked: false });
  let signer: Address | null = null;
  try {
    signer = await recoverMessageAddress({ message: codexLogoutMessage(claim), signature });
  } catch {}
  if (!signer || !isAddressEqual(signer, session.signer)) {
    limits.failures.spend(client);
    return fail(401, "not the owner", "only the key that made this login can revoke it");
  }
  try {
    deps.sessions.revoke(claim.secretHash, nowSec);
  } catch (err) {
    return fail(503, "sessions unavailable", err instanceof Error ? err.message : String(err));
  }
  return json(200, { revoked: true });
}

// --- The Codex route for a login ----------------------------------------------------------------

/** The ENS name typed into Codex's login screen, sent as "Authorization: Bearer <name>". */
function typedName(headers: Headers): string | null {
  const bearer = headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return bearer || headers.get("x-api-key")?.trim() || null;
}

const sameName = (typed: string, name: string, deps: RelayDeps) => {
  const n = tryNormalize(typed.trim());
  return !!n && applyDnsAlias(n, deps.config.dnsAlias) === name;
};

/**
 * The login's secret (x-relay-login) and the provider path after /api/relay/codex/login; null for other
 * paths. Never a secret in the URL: proxies log URLs, and Codex prints them in its errors.
 */
export function loginRequestParts(url: URL, headers: Headers): { secret: string; rest: string } | null {
  const p = url.pathname;
  if (p !== CODEX_LOGIN_PATH && !p.startsWith(`${CODEX_LOGIN_PATH}/`)) return null;
  return { secret: headers.get(CODEX_LOGIN_HEADER)?.trim() ?? "", rest: p.slice(CODEX_LOGIN_PATH.length) };
}

/**
 * Handles <relay>/api/relay/codex/login/<path> (secret in x-relay-login): finds the login, checks the typed name and hands the call
 * to the relay as /api/relay/codex/<path> from the session's agent, answered the way Codex understands
 * (OpenAI errors, usage-limit 429s and headers).
 */
export async function handleCodexSessionRequest(request: Request, deps: CodexSessionDeps): Promise<Response> {
  const limits = deps.limits ?? relayLimits();
  const relayDepsWithLimits: RelayDeps = { ...deps, limits };
  const client = clientKey(request.headers);
  const url = new URL(request.url);
  const { secret, rest } = loginRequestParts(url, request.headers) ?? { secret: "", rest: "" };

  const refused = (status: number, error: string, reason: string, headers: Record<string, string> = {}) => {
    deps.meter.countRejected();
    return openaiErrorResponse(status, error, reason, headers);
  };
  const broken = deps.sessions.unavailable();
  if (broken) return refused(503, "sessions unavailable", `Codex logins are unavailable on this relay: ${broken}`);

  const session = LOGIN_SECRET.test(secret) ? deps.sessions.get(loginSecretHash(secret), nowSecOf(deps)) : null;
  const typed = typedName(request.headers);
  const failed = session === null || (typed !== null && !sameName(typed, session.member, deps) && !sameName(typed, session.agent, deps));
  if (failed) {
    if (!limits.failures.has(client)) return refused(429, "too many failed requests", "Too many refused requests from this address. Wait a minute and try again.", { "retry-after": "60" });
    limits.failures.spend(client);
    if (!session) return refused(401, "login expired", "This Codex login has expired or was revoked. Run relay login again.");
    return refused(401, "wrong name", `This login is for ${session.member}. Run codex logout, then sign in again with "Provide your own API key" and type ${session.member}.`);
  }
  if (typed === null) {
    return refused(401, "not signed in", `Sign in to Codex with your ENS name: choose "Provide your own API key" and type ${session.member}.`);
  }

  // The relay's own route for the same call: /api/relay/codex/<path>, never with the secret in it.
  const pathname = `/api/relay/codex${rest}`;
  let target: URL;
  try {
    target = new URL(`${pathname}${url.search}`, url.origin);
  } catch {
    return refused(400, "bad path", "bad path");
  }
  if (target.pathname !== pathname) return refused(400, "bad path", "dot segments are not allowed");
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("x-api-key");
  headers.delete(CODEX_LOGIN_HEADER);
  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? null : request.body;
  // duplex: "half" is required to send a stream as a request body (Node's fetch); not yet in lib.dom's RequestInit.
  const init: RequestInit & { duplex?: "half" } = { method: request.method, headers, signal: request.signal };
  if (body) {
    init.body = body;
    init.duplex = "half";
  }
  return handleRelayRequest(new Request(target, init), "codex", relayDepsWithLimits, {
    caller: { name: session.agent, signer: session.signer, issuedAt: session.iat },
    codexClient: true,
  });
}
