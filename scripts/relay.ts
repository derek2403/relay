// ./relay: the user's side of Keyless Relay.
//
// The user holds one wallet key and an ENS name the admin gave it
// (derek.dev.eng.acme.eth). `login` gives that name a registry of its own and
// creates the Codex agent codex.<name>, owned by a fresh agent key, with its
// limits on the user's resolver. `codex` starts Codex pointed at the relay
// with a token signed by the agent key; Codex can then create subagents
// (research.codex.<name>) through the ens-subagents skill. Only the user's key
// sends transactions; agent keys only sign tokens.
//
// Files, in RELAY_HOME (default ~/.relay; folder 700, files 600):
//   user.json            the user's key { address, privateKey }
//   config.json          { relayUrl, rpcUrl? }
//   session.json         the current agent session
//   agents/<name>.json   agent and subagent keys
//   agents/.tx.lock      held while a command sends the user's transactions (one at a time)
//   codex/               CODEX_HOME for subagent runs (they may run inside Codex's sandbox)
// Codex (./relay codex) may write only agents/ and codex/, never user.json or config.json.
//
// Settings: --relay / RELAY_URL / config.json (default http://localhost:3000),
// --rpc / RELAY_RPC_URL / NEXT_PUBLIC_SEPOLIA_RPC_URL / config.json (default: a public Sepolia RPC).
// The repo's .env.local fills in RELAY_PUBLIC_URL and the RPC variables (and nothing else).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { type Address, type Hex, formatEther, isAddress, isAddressEqual, isHex, zeroAddress } from "viem";
import { type PrivateKeyAccount, generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { tryNormalize } from "../lib/ens/names";
import { RegistryRoles } from "../lib/ens/roles";
import { type Bundle, type ProviderId, bundleRecordKeys, parseBundle } from "../lib/relay/bundle";
import { countUnit } from "../lib/relay/catalog";
import { DEFAULT_MAX_TOKEN_TTL_SEC, createToken } from "../lib/relay/token";
import type { FundResponse, LevelView, OwnedResponse, PolicyResponse, StatusResponse } from "../lib/relay/types";
import {
  type Chain,
  DEFAULT_RPC_URL,
  REPO_ROOT,
  Sender,
  type Step,
  UserError,
  type WalkLevel,
  bundleWrites,
  chainNow,
  connect,
  envRpc,
  hasCode,
  hasRootRoles,
  loadEnvFiles,
  nowSec,
  parentIs,
  readEntry,
  readParent,
  readTexts,
  registryAddress,
  resolverAddress,
  runSteps,
  shortError,
  tx,
  walkName,
} from "./lib/ensv2";

// --- Output ------------------------------------------------------------------------------

const out = (line = "") => process.stdout.write(`${line}\n`);
const info = (line = "") => process.stderr.write(`${line}\n`);
const done = (line: string) => info(`  ✓ ${line}`);

/** The relay (or the chain) says a name above us was removed. Printed exactly, exit 1. */
class RevokedError extends Error {
  constructor(readonly removed: string) {
    // Same words as the relay's refusal (lib/relay/policy.ts revokedReason), so Codex and the CLI say one thing.
    super(`access revoked: ${removed} was removed or expired. Run ./relay login.`);
  }
}

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  if (n === 0) return "$0";
  return n >= 1 ? `$${n.toFixed(2).replace(/\.00$/, "")}` : `$${n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}

const fmtClock = (sec: number) => new Date(sec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtDate = (sec: number) =>
  sec > 1e12 ? "never" : new Date(sec * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

function fmtLeft(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`;
  return `${Math.floor(s / 86400)} days`;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** "Codex $5 · 2 images" (the period is left out: agents and subagents use "total"). */
function limitsText(b: Bundle): string {
  const plural = (n: number, unit: string) => `${n} ${n === 1 ? unit.replace(/s$/, "") : unit}`;
  return b.keys
    .map((k) => {
      const parts = [b.caps[k] !== undefined ? fmtUsd(b.caps[k]) : null, b.maxes?.[k] !== undefined ? plural(b.maxes[k]!, countUnit(k)) : null].filter(Boolean);
      if (k === "openai-images" && b.caps[k] === undefined && b.maxes?.[k] !== undefined) return parts[0];
      return [k === "codex" ? "Codex" : k, ...parts].join(" ");
    })
    .join(" · ");
}

// --- Home and settings ---------------------------------------------------------------------

// Captured before .env.local is read, so a real environment variable beats config.json, which beats .env.local.
const REAL_ENV_RPC = envRpc();
const REAL_ENV_RELAY = process.env.RELAY_URL?.trim() || "";
loadEnvFiles(["RELAY_RPC_URL", "NEXT_PUBLIC_SEPOLIA_RPC_URL", "RELAY_PUBLIC_URL", "RELAY_IMAGE_MODEL", "RELAY_CODEX_MODEL"]);

const HOME = path.resolve(process.env.RELAY_HOME?.trim() || path.join(os.homedir(), ".relay"));
const WORKSPACE = path.join(REPO_ROOT, "demo-workspace");
const files = {
  user: path.join(HOME, "user.json"),
  config: path.join(HOME, "config.json"),
  session: path.join(HOME, "session.json"),
  agents: path.join(HOME, "agents"),
  codexHome: path.join(HOME, "codex"),
};

type UserKey = { address: Address; privateKey: Hex; createdAt: string };
type AgentKey = { name: string; address: Address; privateKey: Hex; createdAt: string; expiry?: number };
type Config = { relayUrl?: string; rpcUrl?: string };
type Session = { user: string; agent: string; agentAddress: Address; expiry: number; relayUrl: string; createdAt: string };

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function ensureHome() {
  // Inside Codex's sandbox HOME itself isn't writable (only agents/ and codex/ are), so touch it only when needed.
  if (!fs.existsSync(HOME)) fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  if ((fs.statSync(HOME).mode & 0o777) !== 0o700) fs.chmodSync(HOME, 0o700);
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * Runs `fn` while holding RELAY_HOME/agents/.tx.lock, so two ./relay commands
 * (e.g. Codex creating two subagents at once) never send the user's
 * transactions with the same nonce. A lock left by a process that is gone, or
 * older than 10 minutes, is taken over.
 */
async function withTxLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = path.join(files.agents, ".tx.lock");
  fs.mkdirSync(files.agents, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 10 * 60_000;
  let told = false;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let stale = false;
    try {
      const pid = Number(fs.readFileSync(lock, "utf8"));
      stale = Date.now() - fs.statSync(lock).mtimeMs > 10 * 60_000;
      if (!stale && Number.isInteger(pid) && pid > 0) process.kill(pid, 0);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH" || code === "ENOENT") stale = true; // the holder is gone (or just finished)
    }
    if (stale) {
      fs.rmSync(lock, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new UserError(`Another ./relay command is still sending transactions (${lock}). Try again when it finishes.`);
    if (!told) info("  … waiting for another ./relay command to finish its transactions");
    told = true;
    await sleep(1000);
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** Writes owner-only JSON atomically (a replaced key is never half-written). */
function writeSecret(file: string, data: unknown) {
  ensureHome();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

const readConfig = () => readJson<Config>(files.config) ?? {};

function normalizeRelayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error();
  } catch {
    throw new UserError(`"${raw}" is not a valid relay URL (expected e.g. http://localhost:3000).`);
  }
  // Accept the API base too (…/api/relay): the CLI adds the paths itself.
  return `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/api\/relay$/, "")}`;
}

type Opts = {
  relay?: string;
  rpc?: string;
  name?: string;
  as?: string;
  hours?: string;
  minutes?: string;
  codex?: string;
  images?: string;
  prompt?: string;
  out?: string;
  size?: string;
  model?: string;
  json?: boolean;
  force?: boolean;
  all?: boolean;
  help?: boolean;
};

const relayUrl = (opts: Opts) =>
  normalizeRelayUrl(opts.relay || REAL_ENV_RELAY || readConfig().relayUrl || process.env.RELAY_PUBLIC_URL?.trim() || "http://localhost:3000");
const rpcUrl = (opts: Opts) => opts.rpc || REAL_ENV_RPC || readConfig().rpcUrl || envRpc() || DEFAULT_RPC_URL;

let chainCache: Promise<Chain> | null = null;
const getChain = (opts: Opts) => (chainCache ??= connect(rpcUrl(opts)));

function userKey(): { key: UserKey; account: PrivateKeyAccount } {
  const key = readJson<UserKey>(files.user);
  if (!key) throw new UserError(`No key in ${HOME}. Run ./relay init first.`);
  if (!isHex(key.privateKey) || key.privateKey.length !== 66) throw new UserError(`${files.user} has no valid private key.`);
  return { key, account: privateKeyToAccount(key.privateKey) };
}

const agentFile = (name: string) => path.join(files.agents, `${name}.json`);

function loadAgentKey(name: string): { key: AgentKey; account: PrivateKeyAccount } | null {
  const key = readJson<AgentKey>(agentFile(name));
  if (!key || !isHex(key.privateKey) || key.privateKey.length !== 66) return null;
  return { key, account: privateKeyToAccount(key.privateKey) };
}

function newAgentKey(name: string): { key: AgentKey; account: PrivateKeyAccount } {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const key: AgentKey = { name, address: account.address, privateKey, createdAt: new Date().toISOString() };
  writeSecret(agentFile(name), key);
  return { key, account };
}

const agentKeyOrNew = (name: string) => loadAgentKey(name) ?? newAgentKey(name);

function requireSession(): Session {
  const s = readJson<Session>(files.session);
  if (!s?.agent || !s.user) throw new UserError("No agent session. Run ./relay login first.");
  return s;
}

const labelOf = (name: string) => name.split(".")[0];
const parentOf = (name: string) => name.slice(name.indexOf(".") + 1);

function positiveNumber(raw: string | undefined, flag: string, fallback: number, opts: { integer?: boolean; zeroOk?: boolean } = {}): number {
  if (raw === undefined) return fallback;
  const n = Number(raw.replace(/^\$/, ""));
  if (!Number.isFinite(n) || n < 0 || (n === 0 && !opts.zeroOk) || (opts.integer && !Number.isInteger(n))) {
    throw new UserError(`${flag} must be a ${opts.integer ? "whole" : "positive"} number (got "${raw}").`);
  }
  return n;
}

// --- Relay HTTP ------------------------------------------------------------------------------

type HttpResult = { status: number; ok: boolean; json: unknown; text: string; headers: Headers };

async function http(url: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<HttpResult> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const why = err instanceof Error && err.name === "TimeoutError" ? "timed out" : shortError(err);
    throw new UserError(`Could not reach the relay at ${new URL(url).origin} (${why}). Is it running (npm run dev)?`);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, ok: res.ok, json, text, headers: res.headers };
}

/** The relay's own error body ({ error, reason }), if that's what came back. */
function relayError(json: unknown): { error: string; reason?: string } | null {
  const j = json as { error?: unknown; reason?: unknown } | null;
  return j && typeof j.error === "string" ? { error: j.error, reason: typeof j.reason === "string" ? j.reason : undefined } : null;
}

/** Throws RevokedError when the relay says "access revoked", naming the removed name it reports. */
function throwIfRevoked(r: HttpResult, fallback: string) {
  const err = relayError(r.json);
  const text = err ? `${err.error} ${err.reason ?? ""}` : r.ok ? "" : r.text;
  if (!/access revoked/i.test(text)) return;
  const named = text.match(/access revoked:?\s+(\S+?)\s+was removed/i)?.[1];
  throw new RevokedError(named ?? fallback);
}

const describeRefusal = (r: HttpResult) => {
  const err = relayError(r.json);
  if (err) return err.reason ?? err.error;
  const upstream = (r.json as { error?: { message?: string } | string } | null)?.error;
  return (typeof upstream === "string" ? upstream : upstream?.message) ?? (r.text.slice(0, 300) || `HTTP ${r.status}`);
};

async function getStatus(base: string): Promise<StatusResponse | null> {
  try {
    const r = await http(`${base}/api/relay/status`, {}, 10_000);
    return r.ok ? (r.json as StatusResponse) : null;
  } catch {
    return null;
  }
}

async function getOwned(base: string, address: Address): Promise<OwnedResponse> {
  let r = await http(`${base}/api/ens/owned?address=${address}`);
  // The relay answers 503 while its first walk of the company tree is still running.
  for (let waited = 0; r.status === 503 && waited < 60; waited += 3) {
    if (!waited) info("  … the relay is still reading the company tree");
    await new Promise((res) => setTimeout(res, 3000));
    r = await http(`${base}/api/ens/owned?address=${address}`);
  }
  if (!r.ok || !r.json) {
    const why = r.status === 404 && !relayError(r.json) ? "this relay has no /api/ens/owned yet" : describeRefusal(r);
    throw new UserError(`The relay could not list your names (${r.status}: ${why}). Pass --name <your ENS name> instead.`);
  }
  return r.json as OwnedResponse;
}

async function getPolicy(base: string, name: string, token: string): Promise<PolicyResponse | null> {
  const r = await http(`${base}/api/relay/policy?name=${encodeURIComponent(name)}`, { headers: { authorization: `Bearer ${token}` } }, 20_000);
  throwIfRevoked(r, name);
  return r.ok ? (r.json as PolicyResponse) : null;
}

// --- Tokens ------------------------------------------------------------------------------------

let warnedAud = false;

/**
 * A relay token for `name`, signed by its owner key. It ends at the name's ENS
 * expiry or the relay's longest allowed lifetime, whichever is first, and is
 * bound to the origin this CLI actually calls (its audience). The relay's own
 * claim about its public URL is never used for that: a wrong or hostile relay
 * could otherwise get tokens that work on another relay.
 */
async function signToken(account: PrivateKeyAccount, name: string, expiry: number, base: string, status?: StatusResponse | null) {
  const s = status === undefined ? await getStatus(base) : status;
  const maxTtl = s?.maxTokenTtlSec ?? DEFAULT_MAX_TOKEN_TTL_SEC;
  const aud = new URL(base).origin;
  let claimed: string | null = null;
  try {
    if (s?.baseUrl) claimed = new URL(s.baseUrl).origin;
  } catch {}
  const local = (o: string) => o.replace(/\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/, "//localhost");
  if (claimed && local(claimed) !== local(aud) && !warnedAud) {
    warnedAud = true;
    info(`  ! the relay at ${aud} says its public URL is ${claimed}; tokens are bound to ${aud}. If they are refused, set RELAY_URL=${claimed} or add ${aud} to RELAY_AUDIENCES on the relay.`);
  }
  const iat = nowSec();
  const exp = Math.min(expiry, iat + maxTtl - 60);
  return { token: await createToken(account, { name, iat, exp, aud }), exp };
}

// --- Reading where we stand -------------------------------------------------------------------

type Actor = { name: string; account: PrivateKeyAccount; key: AgentKey; expiry: number; level: WalkLevel };

/**
 * Checks on-chain that `name` is still reachable and owned by the key here.
 * A missing level at or above the user means the admin removed it.
 */
async function checkAlive(chain: Chain, session: Session, name: string, key: AgentKey | null) {
  const { levels, broken } = await walkName(chain.pub, name);
  const depthOf = (n: string) => n.split(".").length;
  if (broken) {
    if (depthOf(broken.name) <= depthOf(session.user)) throw new RevokedError(broken.name);
    const removedEarly = (scheduled: number | undefined) => !!broken.entry && !!scheduled && broken.entry.expiry < scheduled - 60;
    if (broken.name === session.agent) {
      if (removedEarly(session.expiry)) throw new RevokedError(session.agent);
      throw new UserError(`The agent session ${session.agent} ended at ${fmtDate(broken.entry?.expiry || session.expiry)}. Run ./relay login.`);
    }
    throw new UserError(
      `${broken.name} ${removedEarly(key?.expiry) ? "was removed" : "has expired"}. Create it again: ./relay subagent create ${labelOf(broken.name)}`,
    );
  }
  const level = levels[levels.length - 1];
  if (key && (!level.entry?.owner || !isAddressEqual(level.entry.owner, key.address))) {
    throw new UserError(`${name} now belongs to ${level.entry?.owner ?? "nobody"}, not the key in ${HOME}. Run ./relay login.`);
  }
  return { levels, level };
}

/** The agent itself (--as omitted, "agent", its label or full name) or one of its subagents. */
async function resolveActor(opts: Opts): Promise<Actor> {
  const session = requireSession();
  const agent = session.agent;
  const raw = (opts.as ?? "").trim().toLowerCase();
  let name: string;
  if (!raw || raw === "agent" || raw === labelOf(agent) || raw === agent) name = agent;
  else if (raw.endsWith(`.${agent}`)) name = raw;
  else {
    const label = tryNormalize(raw);
    if (!label || label.includes(".")) throw new UserError(`--as takes a subagent label like "research" (got "${opts.as}").`);
    name = `${label}.${agent}`;
  }
  const loaded = loadAgentKey(name);
  if (!loaded) {
    throw new UserError(
      name === agent ? `No key for ${agent} in ${HOME}. Run ./relay login.` : `No subagent ${name} here. Create it: ./relay subagent create ${labelOf(name)}`,
    );
  }
  const chain = await getChain(opts);
  const { level } = await checkAlive(chain, session, name, loaded.key);
  return { name, account: loaded.account, key: loaded.key, expiry: level.entry!.expiry, level };
}

/** "Codex $0.12 of $5 · images 1 of 2" for the name's own level (from the relay's policy view). */
function usageLine(level: LevelView | undefined): string {
  if (!level?.bundle) return "no limits found";
  const b = level.bundle;
  return b.keys
    .map((k) => {
      const parts: string[] = [];
      const spent = level.spent[k] ?? 0;
      const max = b.maxes?.[k];
      if (b.caps[k] !== undefined) parts.push(`${fmtUsd(spent)} of ${fmtUsd(b.caps[k])}`);
      else if (spent > 0 && max === undefined) parts.push(`${fmtUsd(spent)} spent`);
      if (max !== undefined) parts.push(`${level.used?.[k] ?? 0} of ${max}${k === "openai-images" ? "" : ` ${countUnit(k)}`}`);
      const label = k === "codex" ? "Codex" : k === "openai-images" ? "images" : k;
      return parts.length ? `${label} ${parts.join(", ")}` : label;
    })
    .join(" · ");
}

// --- Gas -----------------------------------------------------------------------------------------

// Login used about 1.2M gas on a Sepolia fork and each subagent about 0.35M; this leaves headroom for two subagents and retries.
const LOGIN_GAS = 3_000_000n;
// Login plus two subagents; below this a missing top-up is worth a warning.
const MIN_GAS = 2_000_000n;

async function ensureGas(chain: Chain, address: Address, userName: string, base: string) {
  const { pub } = chain;
  const fees = await pub.estimateFeesPerGas();
  const need = LOGIN_GAS * fees.maxFeePerGas;
  const before = await pub.getBalance({ address });
  if (before >= need) {
    done(`your wallet has ${Number(formatEther(before)).toFixed(4)} ETH for gas`);
    return;
  }
  info(`  … your wallet has ${Number(formatEther(before)).toFixed(4)} ETH; asking the relay to top it up`);
  let reason: string;
  try {
    const r = await http(`${base}/api/fund`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: userName }) }, 120_000);
    const body = r.json as FundResponse | null;
    if (r.ok && body?.funded) {
      info(`  … the relay sent ${body.amountEth} ETH (${body.txHash}); waiting for it`);
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const now = await pub.getBalance({ address });
        if (now > before) {
          done(`wallet topped up: ${Number(formatEther(now)).toFixed(4)} ETH`);
          return;
        }
        await new Promise((res) => setTimeout(res, chain.local ? 300 : 3000));
      }
      reason = "the top-up did not arrive within 3 minutes";
    } else {
      reason = body && !body.funded ? body.reason : describeRefusal(r);
    }
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }
  if (before >= MIN_GAS * fees.maxFeePerGas) {
    done(`your wallet has ${Number(formatEther(before)).toFixed(4)} ETH for gas (no top-up: ${reason})`);
    return;
  }
  if (before > 0n) {
    info(`  ! no top-up (${reason}); trying with what the wallet has`);
    return;
  }
  throw new UserError(`Your wallet ${address} has no Sepolia ETH and the relay could not top it up (${reason}). Send it about 0.01 Sepolia ETH, then run ./relay login again.`);
}

// --- init ----------------------------------------------------------------------------------------

function cmdInit(opts: Opts) {
  const existing = readJson<UserKey>(files.user);
  if (existing && !opts.force) {
    throw new UserError(`You already have a key in ${HOME} (${existing.address}). It may own your ENS name, so it was kept. Use --force to replace it.`);
  }
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  writeSecret(files.user, { address: account.address, privateKey, createdAt: new Date().toISOString() } satisfies UserKey);
  const config: Config = { ...readConfig(), relayUrl: relayUrl(opts) };
  if (opts.rpc) config.rpcUrl = opts.rpc;
  writeSecret(files.config, config);
  if (existing) {
    fs.rmSync(files.session, { force: true });
    fs.rmSync(files.agents, { recursive: true, force: true });
  }
  if (opts.json) {
    out(JSON.stringify({ address: account.address, home: HOME, relayUrl: config.relayUrl }));
    return;
  }
  out(account.address);
  info(`Your key is in ${files.user} (only you can read it). Relay: ${config.relayUrl}`);
  info("Send this address to your admin.");
}

// --- login ---------------------------------------------------------------------------------------

async function sessionStillValid(opts: Opts, session: Session): Promise<boolean> {
  const agentKey = loadAgentKey(session.agent);
  if (!agentKey) return false;
  try {
    const chain = await getChain(opts);
    const { level } = await checkAlive(chain, session, session.agent, agentKey.key);
    return !!level.entry && level.entry.expiry > (await chainNow(chain.pub)) + 300;
  } catch (err) {
    if (err instanceof RevokedError || err instanceof UserError) return false;
    throw err;
  }
}

async function findUserName(opts: Opts, address: Address, base: string): Promise<string> {
  if (opts.name) {
    const name = tryNormalize(opts.name);
    if (!name || !name.includes(".")) throw new UserError(`"${opts.name}" is not a valid ENS name.`);
    return name;
  }
  const owned = await getOwned(base, address);
  const names = owned.names ?? [];
  if (!names.length) throw new UserError(`No ENS name found for ${address}. Ask your admin to add this address.`);
  // Anyone who controls a registry can register a name to your address without asking, so only names the
  // company added (every level above held by the company owner) count. Older relays don't say: all count.
  const added = names.filter((n) => n.member !== false);
  if (added.length === 1) return added[0].name;
  const list = (added.length ? added : names).map((n) => n.name).join(", ");
  if (!added.length) {
    throw new UserError(`${address} holds ${list}, but none was added by the company. Ask your admin to add this address, or pass --name <your ENS name>.`);
  }
  throw new UserError(`${address} holds several names (${list}). Pick yours with --name <name>.`);
}

async function login(opts: Opts): Promise<Session> {
  const { account } = userKey();
  const base = relayUrl(opts);
  const previous = readJson<Session>(files.session);
  if (previous && !opts.force && (!opts.name || tryNormalize(opts.name) === previous.user) && (await sessionStillValid(opts, previous))) {
    info(`Session still valid: ${previous.agent} until ${fmtClock(previous.expiry)} (${fmtLeft(previous.expiry - nowSec())} left).`);
    return previous;
  }
  if (previous) fs.rmSync(files.session, { force: true });

  const chain = await getChain(opts);
  const { pub } = chain;
  const userName = await findUserName(opts, account.address, base);
  const { levels, broken } = await walkName(pub, userName);
  const userLevel = levels[levels.length - 1];
  if (broken || !userLevel.entry || !userLevel.registry) {
    throw new UserError(
      broken && broken.name !== userName
        ? `${userName} can't be reached: ${broken.name} is not registered.`
        : `No ENS name found for ${account.address} (${userName} is not registered). Ask your admin to add this address.`,
    );
  }
  const entry = userLevel.entry;
  if (!entry.owner || !isAddressEqual(entry.owner, account.address)) {
    throw new UserError(`${userName} belongs to ${entry.owner}, not your key ${account.address}.`);
  }
  info(`Logging in as ${userName}`);
  done(`found ${userName} (yours, expires ${fmtDate(entry.expiry)})`);
  await ensureGas(chain, account.address, userName, base);

  // What the user may use (its bundle, on the team's resolver): the agent never lists more.
  const userBundle = entry.resolver ? parseBundle(await readTexts(pub, entry.resolver, userName, bundleRecordKeys())) : null;
  const codexUsd = positiveNumber(opts.codex, "--codex", 5, { zeroOk: true });
  const images = positiveNumber(opts.images, "--images", 2, { integer: true, zeroOk: true });
  const hours = positiveNumber(opts.hours, "--hours", 8);
  const bundle: Bundle = { keys: [], caps: {}, maxes: {}, period: "total" };
  const allow = (p: ProviderId) => !userBundle || userBundle.keys.includes(p);
  if (codexUsd > 0 && allow("codex")) {
    bundle.keys.push("codex");
    bundle.caps.codex = codexUsd;
  }
  if (images > 0 && allow("openai-images")) {
    bundle.keys.push("openai-images");
    bundle.maxes!["openai-images"] = images;
  }
  if (!bundle.keys.length) throw new UserError(`${userName} allows neither codex nor openai-images. Ask your admin.`);
  for (const p of ["codex", "openai-images"] as const) if (!allow(p)) info(`  ! ${userName} doesn't allow ${p}, so the agent won't get it`);

  const teamRegistry = userLevel.registry;
  const resolver = await resolverAddress(pub, account.address);
  let userRegistry = entry.subregistry;
  if (userRegistry && !(await hasRootRoles(pub, userRegistry, RegistryRoles.ROLE_REGISTRAR, account.address))) {
    throw new UserError(`${userName} already has a subname registry (${userRegistry}) that your key doesn't control.`);
  }
  userRegistry ??= await registryAddress(pub, account.address, userName);
  const userLabel = labelOf(userName);
  const agentName = `codex.${userName}`;
  const agentLabel = "codex";
  const agentRegistry = await registryAddress(pub, account.address, agentName);
  const agent = agentKeyOrNew(agentName);
  const now = await chainNow(pub);
  const expiry = Math.min(now + Math.round(hours * 3600), entry.expiry);
  const agentEntry = () => readEntry(pub, userRegistry!, agentLabel);
  const current = await agentEntry();
  const staleAgent = current.registered && !!current.owner && !isAddressEqual(current.owner, agent.account.address);
  const limits = limitsText(bundle);

  const steps: Step[] = [
    { id: "resolver", title: `deployed your resolver (it holds your agents' limits)`, done: () => hasCode(pub, resolver), tx: () => tx.deployResolver(account.address) },
    { id: "registry", title: `deployed your registry (names under ${userName})`, done: () => hasCode(pub, userRegistry!), tx: () => tx.deployRegistry(account.address, userName) },
    {
      id: "attach",
      title: `attached it under ${userName}`,
      done: async () => {
        const e = await readEntry(pub, teamRegistry, userLabel);
        return !!e.subregistry && isAddressEqual(e.subregistry, userRegistry!);
      },
      tx: () => tx.setSubregistry(teamRegistry, userLabel, userRegistry!),
    },
    {
      id: "parent",
      title: `pointed it back at ${parentOf(userName)}`,
      deps: ["registry"],
      done: async () => parentIs(await readParent(pub, userRegistry!), teamRegistry, userLabel),
      tx: () => tx.setParent(userRegistry!, teamRegistry, userLabel),
    },
    { id: "agent-registry", title: `deployed the agent's registry (for its subagents)`, done: () => hasCode(pub, agentRegistry), tx: () => tx.deployRegistry(account.address, agentName) },
  ];
  if (staleAgent) {
    // An earlier session's agent key is gone: the user holds every role on its own registry, so it can clear the label.
    steps.push({
      id: "clear",
      title: `removed the old ${agentName} (its key is no longer here)`,
      deps: ["registry"],
      done: async () => {
        const e = await agentEntry();
        return !e.registered || (!!e.owner && isAddressEqual(e.owner, agent.account.address));
      },
      tx: () => tx.unregister(userRegistry!, agentLabel),
    });
  }
  steps.push(
    {
      id: "agent",
      title: `created ${agentName} (${limits}, ${hours} h)`,
      deps: ["registry", ...(staleAgent ? ["clear"] : [])],
      done: async () => {
        const e = await agentEntry();
        return e.registered && !!e.owner && isAddressEqual(e.owner, agent.account.address);
      },
      // Owner = the agent key with no roles: it can sign tokens but not change anything.
      // Its own registry is attached in the same transaction (the user holds all roles on its registry).
      tx: () => tx.register(userRegistry!, agentLabel, agent.account.address, agentRegistry, resolver, 0n, expiry),
    },
    {
      id: "renew",
      title: `extended ${agentName} to ${fmtClock(expiry)}`,
      deps: ["agent"],
      done: async () => (await agentEntry()).expiry >= expiry - 120,
      tx: () => tx.renew(userRegistry!, agentLabel, expiry),
    },
    {
      id: "agent-attach",
      title: `attached the agent's registry under ${agentName}`,
      deps: ["agent"],
      done: async () => {
        const e = await agentEntry();
        return !!e.subregistry && isAddressEqual(e.subregistry, agentRegistry);
      },
      tx: () => tx.setSubregistry(userRegistry!, agentLabel, agentRegistry),
    },
    {
      id: "agent-parent",
      title: `pointed the agent's registry back at ${userName}`,
      deps: ["agent-registry"],
      done: async () => parentIs(await readParent(pub, agentRegistry), userRegistry!, agentLabel),
      tx: () => tx.setParent(agentRegistry, userRegistry!, agentLabel),
    },
    {
      id: "limits",
      title: `wrote ${agentName}'s limits: ${limits}`,
      deps: ["resolver"],
      done: async () => (await bundleWrites(pub, resolver, agentName, bundle, agent.account.address)).length === 0,
      tx: async () => {
        const calls = await bundleWrites(pub, resolver, agentName, bundle, agent.account.address);
        return calls.length ? tx.resolverMulticall(resolver, calls) : null;
      },
    },
  );

  const sender = new Sender(chain, account, done);
  await withTxLock(() => runSteps(sender, steps, { skipped: (t) => done(`${t} (already done)`) }));

  const final = await agentEntry();
  const session: Session = {
    user: userName,
    agent: agentName,
    agentAddress: agent.account.address,
    expiry: final.expiry || expiry,
    relayUrl: base,
    createdAt: new Date().toISOString(),
  };
  writeSecret(agentFile(agentName), { ...agent.key, expiry: session.expiry });
  writeSecret(files.session, session);
  info(`Session ready: ${agentName} until ${fmtClock(session.expiry)} (${fmtLeft(session.expiry - nowSec())}).`);
  return session;
}

async function cmdLogin(opts: Opts) {
  const session = await login(opts);
  if (opts.json) out(JSON.stringify(session));
  else info("Next: ./relay codex");
}

// --- whoami --------------------------------------------------------------------------------------

async function cmdWhoami(opts: Opts) {
  const { account } = userKey();
  const base = relayUrl(opts);
  const chain = await getChain(opts);
  const [balance, owned] = await Promise.all([
    chain.pub.getBalance({ address: account.address }),
    getOwned(base, account.address).then(
      (o) => ({ names: o.names, error: null as string | null }),
      (err) => ({ names: [] as OwnedResponse["names"], error: err instanceof Error ? err.message : String(err) }),
    ),
  ]);
  const session = readJson<Session>(files.session);
  type Row = { name: string; expiry: number | null; status: string; usage: string | null; level: LevelView | null };
  const result = {
    address: account.address,
    relay: base,
    home: HOME,
    balanceEth: formatEther(balance),
    names: owned.names,
    namesError: owned.error,
    agent: null as Row | null,
    subagents: [] as Row[],
  };

  // A removed level (on chain, or as the relay reports it) ends the listing with the revoked line.
  let revoked: RevokedError | null = null;
  if (session) {
    const agentKey = loadAgentKey(session.agent);
    let agentStatus = "active";
    let token: string | null = null;
    let expiry: number | null = session.expiry;
    try {
      const { level } = await checkAlive(chain, session, session.agent, agentKey?.key ?? null);
      expiry = level.entry?.expiry ?? expiry;
      if (agentKey) token = (await signToken(agentKey.account, session.agent, expiry ?? nowSec() + 600, base)).token;
    } catch (err) {
      if (err instanceof RevokedError) revoked = err;
      else if (err instanceof UserError) agentStatus = err.message;
      else throw err;
    }
    const policyOf = async (name: string) => {
      if (!token || revoked) return null;
      try {
        return (await getPolicy(base, name, token))?.levels.at(-1) ?? null;
      } catch (err) {
        if (err instanceof RevokedError) revoked = err;
        return null;
      }
    };
    const agentLevel = await policyOf(session.agent);
    if (revoked) agentStatus = "revoked";
    result.agent = { name: session.agent, expiry, status: agentStatus, usage: agentLevel ? usageLine(agentLevel) : null, level: agentLevel };

    if (!revoked) {
      result.subagents = await Promise.all(
        listSubagentKeys(session.agent).map(async (k): Promise<Row> => {
          let status = "active";
          let subExpiry: number | null = k.expiry ?? null;
          try {
            const { level } = await checkAlive(chain, session, k.name, k);
            subExpiry = level.entry?.expiry ?? subExpiry;
          } catch (err) {
            status = err instanceof Error ? err.message : String(err);
          }
          const level = status === "active" ? await policyOf(k.name) : null;
          return { name: k.name, expiry: subExpiry, status, usage: level ? usageLine(level) : null, level };
        }),
      );
    }
  }
  if (revoked) process.exitCode = 1;

  if (opts.json) {
    out(JSON.stringify({ ...result, revoked: revoked ? (revoked as RevokedError).message : null }, null, 2));
    return;
  }
  out(`Address   ${account.address}`);
  out(`Balance   ${Number(formatEther(balance)).toFixed(4)} ETH`);
  out(`Relay     ${base}`);
  if (owned.error) out(`Names     (unknown: ${owned.error})`);
  else out(`Names     ${owned.names.length ? owned.names.map((n) => n.name).join(", ") : "none (send your address to your admin)"}`);
  if (!result.agent) {
    out("Agent     none (run ./relay login)");
    return;
  }
  const a = result.agent;
  const left = (e: number | null) => (e ? `until ${fmtClock(e)} (${fmtLeft(e - nowSec())} left)` : "");
  out(`Agent     ${a.name} ${a.status === "active" ? left(a.expiry) : `- ${a.status}`}`);
  if (a.usage) out(`          ${a.usage}`);
  for (const s of result.subagents) {
    out(`  ${s.name} ${s.status === "active" ? left(s.expiry) : `- ${s.status}`}`);
    if (s.usage) out(`    ${s.usage}`);
  }
  if (revoked) info((revoked as RevokedError).message);
  else if (a.status === "active" && !a.usage) info("(spend unknown: the relay didn't answer /api/relay/policy)");
}

// --- codex ---------------------------------------------------------------------------------------

/** Writes AGENTS.md and the ens-subagents skill into demo-workspace/ from scripts/templates/. */
function installWorkspace(session: Session, base: string) {
  const fill = (t: string) => t.replaceAll("{{AGENT}}", session.agent).replaceAll("{{USER}}", session.user).replaceAll("{{RELAY}}", base);
  const targets: [string, string][] = [
    [path.join(REPO_ROOT, "scripts", "templates", "AGENTS.md"), path.join(WORKSPACE, "AGENTS.md")],
    [path.join(REPO_ROOT, "scripts", "templates", "SKILL.md"), path.join(WORKSPACE, ".agents", "skills", "ens-subagents", "SKILL.md")],
  ];
  let changed = false;
  for (const [from, to] of targets) {
    const text = fill(fs.readFileSync(from, "utf8"));
    if (readText(to) === text) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, text);
    changed = true;
  }
  done(`${changed ? "installed" : "checked"} the subagent skill and AGENTS.md in demo-workspace/`);
}

const readText = (file: string) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

const EXEC_SUBCOMMANDS = new Set(["exec", "e", "review", "resume", "fork"]);

/**
 * Codex flags that route it through the relay as an ENS name. Codex reads the
 * token from KEYLESS_TOKEN (env_key) and sends it as "Authorization: Bearer".
 * - project_root_markers: demo-workspace/ is the project root, so Codex loads
 *   its AGENTS.md and skill, not the repo's.
 * - Inside Codex's own sandbox (CODEX_SANDBOX is set, e.g. a subagent started
 *   by the agent), macOS can't apply a second seatbelt profile, so the inner
 *   Codex runs without one and stays confined by the outer sandbox (which
 *   writes only the workspace and RELAY_HOME's agents/ and codex/; it can
 *   still read every file, keys included, as any macOS sandboxed process can).
 */
function codexFlags(base: string, opts: { addDirs?: string[]; interactive: boolean; model?: string }): string[] {
  const provider = `{name="Keyless Relay", base_url=${JSON.stringify(`${base}/api/relay/codex/v1`)}, env_key="KEYLESS_TOKEN", env_key_instructions="Start Codex with ./relay codex", wire_api="responses"}`;
  const nested = !!process.env.CODEX_SANDBOX;
  return [
    "-c", 'model_provider="keyless"',
    "-c", `model_providers.keyless=${provider}`,
    "-c", 'project_root_markers=[".agents"]',
    ...(nested ? ["-s", "danger-full-access"] : ["-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true"]),
    ...(opts.interactive ? ["-a", "on-request"] : []),
    ...(opts.addDirs ?? []).flatMap((d) => ["--add-dir", d]),
    "-C", WORKSPACE,
    ...(opts.model ? ["-m", opts.model] : []),
  ];
}

/** Runs Codex and resolves with its exit code. `stdin: false` gives it none (codex exec would wait on an open pipe). */
function runCodex(args: string[], env: Record<string, string>, opts: { stdin?: boolean } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, { stdio: [opts.stdin === false ? "ignore" : "inherit", "inherit", "inherit"], env: { ...process.env, ...env } });
    // Ctrl-C reaches Codex directly (same process group); stay alive until it exits. SIGTERM is passed on.
    const ignore = () => {};
    const forward = () => child.kill("SIGTERM");
    process.on("SIGINT", ignore);
    process.on("SIGTERM", forward);
    child.on("error", (err: NodeJS.ErrnoException) =>
      reject(err.code === "ENOENT" ? new UserError("Codex CLI not found. Install it (npm i -g @openai/codex) and try again.") : err),
    );
    child.on("exit", (code, signal) => {
      process.off("SIGINT", ignore);
      process.off("SIGTERM", forward);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

async function cmdCodex(opts: Opts, extra: string[]) {
  const session = await login(opts);
  const base = relayUrl(opts);
  const actor = await resolveActor({ ...opts, as: undefined });
  const status = await getStatus(base);
  if (!status) throw new UserError(`The relay at ${base} is not answering. Start it (npm run dev) and try again.`);
  installWorkspace(session, base);
  const { token, exp } = await signToken(actor.account, actor.name, actor.expiry, base, status);

  const [first, ...rest] = extra;
  const sub = first && EXEC_SUBCOMMANDS.has(first) ? first : null;
  const model = opts.model || process.env.RELAY_CODEX_MODEL?.trim() || undefined;
  // Codex may write subagent keys (agents/) and subagent runs' CODEX_HOME (codex/), not the user's key or settings.
  for (const dir of [files.agents, files.codexHome]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const flags = codexFlags(base, { addDirs: [files.agents, files.codexHome], interactive: !sub, model });
  if (!sub) {
    // Trusted for this run only (in memory), so Codex doesn't ask and doesn't write ~/.codex/config.toml.
    flags.push("-c", `projects={${JSON.stringify(WORKSPACE)}={trust_level="trusted"}, ${JSON.stringify(REPO_ROOT)}={trust_level="trusted"}}`);
  }
  const args = sub ? [sub, ...flags, ...(sub === "exec" || sub === "e" ? ["--skip-git-repo-check"] : []), ...rest] : [...flags, ...extra];
  done(`Codex runs as ${actor.name} (token until ${fmtClock(exp)}); it never sees the OpenAI key`);
  info("");
  process.exitCode = await runCodex(args, { KEYLESS_TOKEN: token, RELAY_HOME: HOME });
}

// --- subagents -------------------------------------------------------------------------------------

function listSubagentKeys(agent: string): AgentKey[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(files.agents);
  } catch {}
  return names
    .filter((f) => f.endsWith(`.${agent}.json`))
    .map((f) => readJson<AgentKey>(path.join(files.agents, f)))
    .filter((k): k is AgentKey => !!k?.name && isAddress(k.address));
}

async function agentContext(opts: Opts) {
  const { account } = userKey();
  const session = requireSession();
  const agentKey = loadAgentKey(session.agent);
  if (!agentKey) throw new UserError(`No key for ${session.agent} in ${HOME}. Run ./relay login.`);
  const chain = await getChain(opts);
  const { level } = await checkAlive(chain, session, session.agent, agentKey.key);
  const agentRegistry = level.entry?.subregistry;
  if (!agentRegistry) throw new UserError(`${session.agent} has no registry for subagents yet. Run ./relay login.`);
  const resolver = await resolverAddress(chain.pub, account.address);
  return { account, session, chain, agentRegistry, agentExpiry: level.entry!.expiry, resolver };
}

function subagentLabel(raw: string | undefined, agent: string): string {
  const label = raw ? tryNormalize(raw) : null;
  if (!label || label.includes(".")) throw new UserError('Give a subagent label, e.g. ./relay subagent create research');
  if (label === "agent" || label === labelOf(agent)) throw new UserError(`"${label}" is reserved; pick another label.`);
  return label;
}

async function cmdSubagentCreate(opts: Opts, rawLabel: string | undefined) {
  const { account, session, chain, agentRegistry, agentExpiry, resolver } = await agentContext(opts);
  const { pub } = chain;
  const label = subagentLabel(rawLabel, session.agent);
  const name = `${label}.${session.agent}`;
  const codexUsd = opts.codex !== undefined ? positiveNumber(opts.codex, "--codex", 1) : undefined;
  const images = opts.images !== undefined ? positiveNumber(opts.images, "--images", 1, { integer: true }) : undefined;
  const minutes = positiveNumber(opts.minutes, "--minutes", 20);
  const bundle: Bundle = { keys: [], caps: {}, maxes: {}, period: "total" };
  // Codex $1 unless only images were asked for.
  if (codexUsd !== undefined || images === undefined) {
    bundle.keys.push("codex");
    bundle.caps.codex = codexUsd ?? 1;
  }
  if (images !== undefined) {
    bundle.keys.push("openai-images");
    bundle.maxes!["openai-images"] = images;
  }

  const sub = agentKeyOrNew(name);
  // A subagent never outlives its agent: the walk would stop at the agent anyway.
  const expiry = Math.min((await chainNow(pub)) + Math.round(minutes * 60), agentExpiry);
  const entry = () => readEntry(pub, agentRegistry, label);
  const current = await entry();
  const stale = current.registered && !!current.owner && !isAddressEqual(current.owner, sub.account.address);
  const ours = async () => {
    const e = await entry();
    return e.registered && !!e.owner && isAddressEqual(e.owner, sub.account.address);
  };
  const limits = limitsText(bundle);
  info(`Creating ${name} (${limits}, ${fmtLeft(expiry - nowSec())})`);
  const steps: Step[] = [];
  if (stale) {
    steps.push({ id: "clear", title: `removed the old ${name}`, done: async () => !(await entry()).registered || (await ours()), tx: () => tx.unregister(agentRegistry, label) });
  }
  steps.push(
    {
      id: "register",
      title: `registered ${name} (owner ${sub.account.address}, no roles)`,
      deps: stale ? ["clear"] : [],
      done: ours,
      // Signed by the user's key: it deployed the agent's registry, so it holds every role on it.
      tx: () => tx.register(agentRegistry, label, sub.account.address, zeroAddress, resolver, 0n, expiry),
    },
    {
      id: "renew",
      title: `extended ${name} to ${fmtClock(expiry)}`,
      deps: ["register"],
      done: async () => (await entry()).expiry >= expiry - 60,
      tx: () => tx.renew(agentRegistry, label, expiry),
    },
    {
      id: "limits",
      title: `wrote its limits: ${limits}`,
      done: async () => (await bundleWrites(pub, resolver, name, bundle, sub.account.address)).length === 0,
      tx: async () => {
        const calls = await bundleWrites(pub, resolver, name, bundle, sub.account.address);
        return calls.length ? tx.resolverMulticall(resolver, calls) : null;
      },
    },
  );
  await withTxLock(() => runSteps(new Sender(chain, account, done), steps, { skipped: (t) => done(`${t} (already done)`) }));
  const final = (await entry()).expiry || expiry;
  writeSecret(agentFile(name), { ...sub.key, expiry: final });
  out(JSON.stringify({ name, expiry: final, limits }));
}

async function cmdSubagentList(opts: Opts) {
  const session = requireSession();
  const chain = await getChain(opts);
  const base = relayUrl(opts);
  const agentKey = loadAgentKey(session.agent);
  const token = agentKey ? await signToken(agentKey.account, session.agent, session.expiry, base).then((t) => t.token, () => null) : null;
  const rows = await Promise.all(
    listSubagentKeys(session.agent).map(async (k) => {
      let status = "active";
      let expiry = k.expiry ?? null;
      try {
        const { level } = await checkAlive(chain, session, k.name, k);
        expiry = level.entry?.expiry ?? expiry;
      } catch (err) {
        if (err instanceof RevokedError) throw err;
        status = err instanceof Error ? err.message : String(err);
      }
      let usage: string | null = null;
      if (status === "active" && token) {
        try {
          usage = usageLine((await getPolicy(base, k.name, token))?.levels.at(-1));
        } catch (err) {
          if (err instanceof RevokedError) throw err;
        }
      }
      return { name: k.name, label: labelOf(k.name), address: k.address, expiry, status, usage };
    }),
  );
  if (opts.json) {
    out(JSON.stringify(rows, null, 2));
    return;
  }
  if (!rows.length) {
    out(`No subagents under ${session.agent}. Create one: ./relay subagent create research --codex 1 --minutes 20`);
    return;
  }
  for (const r of rows) {
    out(`${r.name}  ${r.status === "active" && r.expiry ? `until ${fmtClock(r.expiry)} (${fmtLeft(r.expiry - nowSec())} left)` : r.status}`);
    if (r.usage) out(`  ${r.usage}`);
  }
}

async function cmdSubagentRemove(opts: Opts, rawLabel: string | undefined) {
  const { account, session, chain, agentRegistry } = await agentContext(opts);
  const label = subagentLabel(rawLabel, session.agent);
  const name = `${label}.${session.agent}`;
  const e = await readEntry(chain.pub, agentRegistry, label);
  if (e.registered) {
    await withTxLock(() => new Sender(chain, account, done).sendAll([{ title: `removed ${name} (unregister)`, call: tx.unregister(agentRegistry, label) }]));
  } else {
    done(`${name} was not registered`);
  }
  fs.rmSync(agentFile(name), { force: true });
  if (opts.json) out(JSON.stringify({ removed: name }));
}

// --- Acting as the agent or a subagent ------------------------------------------------------------

async function cmdExec(opts: Opts, words: string[]) {
  const task = words.join(" ").trim();
  if (!opts.as) throw new UserError('Add --as <subagent>, e.g. ./relay exec --as research "Find …"');
  if (!task) throw new UserError('Give the task in quotes, e.g. ./relay exec --as research "Find …"');
  const actor = await resolveActor(opts);
  const session = requireSession();
  const base = relayUrl(opts);
  const { token } = await signToken(actor.account, actor.name, actor.expiry, base);
  const bundle = await actorBundle(opts, actor);
  const prompt =
    actor.name === session.agent
      ? task
      : `You are ${actor.name}, a subagent with its own ENS name and budget (${bundle ? limitsText(bundle) : "see ENS"}). ` +
        `Do this one task, write your answer as your final message, and don't create subagents.\n\nTask: ${task}`;
  fs.mkdirSync(files.codexHome, { recursive: true, mode: 0o700 });
  const model = opts.model || process.env.RELAY_CODEX_MODEL?.trim() || undefined;
  const args = ["exec", ...codexFlags(base, { interactive: false, model }), "--skip-git-repo-check", "--ephemeral", prompt];
  info(`Running Codex as ${actor.name}`);
  // Its own CODEX_HOME: a subagent started by the agent runs inside the agent's sandbox, where ~/.codex is read-only.
  process.exitCode = await runCodex(args, { KEYLESS_TOKEN: token, CODEX_HOME: files.codexHome, RELAY_HOME: HOME }, { stdin: false });
}

async function actorBundle(opts: Opts, actor: Actor): Promise<Bundle | null> {
  const resolver = actor.level.entry?.resolver;
  if (!resolver) return null;
  const chain = await getChain(opts);
  return parseBundle(await readTexts(chain.pub, resolver, actor.name, bundleRecordKeys()));
}

async function cmdImage(opts: Opts) {
  if (!opts.as) throw new UserError('Add --as <subagent>, e.g. ./relay image --as image --prompt "…" --out header.png');
  const prompt = opts.prompt?.trim();
  if (!prompt) throw new UserError('Add --prompt "<what the image shows>"');
  const size = opts.size ?? "1024x1024";
  if (!/^(\d+x\d+|auto)$/.test(size)) throw new UserError(`--size must look like 1024x1024 (got "${size}").`);
  const outFile = path.resolve(opts.out ?? `image-${Date.now()}.png`);
  const actor = await resolveActor(opts);
  const base = relayUrl(opts);
  const { token } = await signToken(actor.account, actor.name, actor.expiry, base);
  const model = process.env.RELAY_IMAGE_MODEL?.trim() || "gpt-image-1";
  // gpt-image models always return base64; DALL·E needs it asked for.
  const body: Record<string, unknown> = { model, prompt, size, n: 1 };
  if (/^dall-e/.test(model)) body.response_format = "b64_json";
  info(`Generating an image as ${actor.name} (${model}, ${size})…`);
  const r = await http(
    `${base}/api/relay/openai-images/v1/images/generations`,
    { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) },
    300_000,
  );
  throwIfRevoked(r, actor.name);
  if (!r.ok) {
    throw new UserError(relayError(r.json) ? `refused by the relay: ${describeRefusal(r)}` : `OpenAI answered ${r.status}: ${describeRefusal(r)}`);
  }
  const item = (r.json as { data?: { b64_json?: string; url?: string }[] } | null)?.data?.[0];
  let bytes: Buffer;
  if (item?.b64_json) bytes = Buffer.from(item.b64_json, "base64");
  else if (item?.url) bytes = Buffer.from(await (await fetch(item.url)).arrayBuffer());
  else throw new UserError(`The image API returned no image: ${r.text.slice(0, 200)}`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, bytes);
  const left = await getPolicy(base, actor.name, token).then((p) => usageLine(p?.levels.at(-1)), () => null);
  out(JSON.stringify({ file: outFile, name: actor.name, bytes: bytes.length }));
  info(`Saved ${path.relative(process.cwd(), outFile) || outFile}${left ? ` · ${left}` : ""}`);
}

async function cmdToken(opts: Opts) {
  const actor = await resolveActor(opts);
  const base = relayUrl(opts);
  const { token, exp } = await signToken(actor.account, actor.name, actor.expiry, base);
  out(token);
  info(`Token for ${actor.name}, valid until ${fmtDate(exp)}.`);
}

async function cmdEnv(opts: Opts) {
  const actor = await resolveActor(opts);
  const base = relayUrl(opts);
  const { token, exp } = await signToken(actor.account, actor.name, actor.expiry, base);
  info(`# ${actor.name} via ${base}, valid until ${fmtDate(exp)}`);
  out(`export KEYLESS_TOKEN=${shellQuote(token)}`);
  out(`export OPENAI_BASE_URL=${shellQuote(`${base}/api/relay/codex/v1`)}`);
  out(`export OPENAI_API_KEY=${shellQuote(token)}`);
}

// --- logout ------------------------------------------------------------------------------------------

function cmdLogout(opts: Opts) {
  if (opts.all) {
    fs.rmSync(HOME, { recursive: true, force: true });
    info(`Deleted ${HOME} (your key too). Run ./relay init to start over.`);
    return;
  }
  const session = readJson<Session>(files.session);
  const keys = fs.existsSync(files.agents) ? fs.readdirSync(files.agents).filter((f) => f.endsWith(".json")).length : 0;
  fs.rmSync(files.session, { force: true });
  fs.rmSync(files.agents, { recursive: true, force: true });
  fs.rmSync(files.codexHome, { recursive: true, force: true });
  info(`Logged out${session ? ` of ${session.agent}` : ""}: deleted the session and ${keys} agent key${keys === 1 ? "" : "s"}. Your own key stays in ${files.user}.`);
  info("The agent's ENS name still exists until it expires; ./relay login replaces it.");
}

// --- Main ----------------------------------------------------------------------------------------------

const HELP = `Keyless Relay: use APIs with your ENS name instead of API keys.

  ./relay init [--relay URL]         Create your key and print your address (send it to your admin)
  ./relay whoami [--json]            Your address, names, balance, agent and subagents with spend
  ./relay login [--name N]           Set up your agent codex.<your name> (Codex $5, 2 images, 8 h)
        [--codex USD] [--images N] [--hours H] [--force]
  ./relay codex [-- <codex args>]    Log in if needed, then start Codex through the relay
                                     (./relay codex exec "…" runs codex exec the same way)
  ./relay subagent create <label> [--codex USD] [--images N] [--minutes M]
  ./relay subagent list [--json]
  ./relay subagent remove <label>
  ./relay exec --as <label> "<task>"               Run codex exec as a subagent
  ./relay image --as <label> --prompt "…" [--out file.png] [--size 1024x1024]
  ./relay token [--as <label>]       Print a relay token (for the agent, or a subagent)
  ./relay env [--as <label>]         Print export lines (KEYLESS_TOKEN, OPENAI_BASE_URL, OPENAI_API_KEY)
  ./relay logout [--all]             Delete the session and agent keys (--all: your key too)

Options: --relay URL (or RELAY_URL), --rpc URL (or RELAY_RPC_URL). Files live in ${HOME} (RELAY_HOME).`;

// Flags that take a value, so the command can be found before parsing (everything after "codex" is Codex's).
const VALUE_FLAGS = new Set(["--relay", "--rpc", "--name", "--as", "--hours", "--minutes", "--codex", "--images", "--prompt", "--out", "-o", "--size", "--model", "-m"]);
/** Flags Codex doesn't have, taken as ours when they follow "codex". */
const CODEX_OWN_FLAGS = new Set(["--relay", "--rpc", "--name", "--hours", "--codex", "--images", "--force"]);

async function main() {
  const argv = process.argv.slice(2);
  let i = 0;
  while (i < argv.length && argv[i].startsWith("-") && argv[i] !== "--") i += VALUE_FLAGS.has(argv[i]) ? 2 : 1;
  const codex = argv[i] === "codex";
  // Our own login flags may also come right after "codex" (./relay codex --hours 2 exec "…").
  let j = i + 1;
  while (codex && CODEX_OWN_FLAGS.has(argv[j]?.split("=")[0])) j += argv[j].includes("=") || argv[j] === "--force" ? 1 : 2;
  const own = codex ? [...argv.slice(0, i + 1), ...argv.slice(i + 1, j)] : argv;
  let parsed: { values: Opts; positionals: string[] };
  try {
    parsed = parseArgs({
      args: own,
      allowPositionals: true,
      options: {
        relay: { type: "string" },
        rpc: { type: "string" },
        name: { type: "string" },
        as: { type: "string" },
        hours: { type: "string" },
        minutes: { type: "string" },
        codex: { type: "string" },
        images: { type: "string" },
        prompt: { type: "string" },
        out: { type: "string", short: "o" },
        size: { type: "string" },
        model: { type: "string", short: "m" },
        json: { type: "boolean" },
        force: { type: "boolean" },
        all: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }) as { values: Opts; positionals: string[] };
  } catch (err) {
    throw new UserError(`${(err instanceof Error ? err.message : String(err)).replace(/\.+$/, "")}. See ./relay help`);
  }
  const { values: opts, positionals } = parsed;
  if (codex) {
    const extra = argv.slice(j);
    return cmdCodex(opts, extra[0] === "--" ? extra.slice(1) : extra);
  }
  const [command, ...rest] = positionals;
  if (!command || command === "help" || opts.help) {
    out(HELP);
    return;
  }
  if (command === "exec") return cmdExec(opts, rest);

  switch (command) {
    case "init":
      return cmdInit(opts);
    case "whoami":
      return cmdWhoami(opts);
    case "login":
      return cmdLogin(opts);
    case "subagent": {
      const [action, label, ...more] = rest;
      if (more.length) throw new UserError(`Unexpected "${more[0]}". See ./relay help`);
      if (action === "create") return cmdSubagentCreate(opts, label);
      if (action === "list" || action === "ls") return cmdSubagentList(opts);
      if (action === "remove" || action === "rm") return cmdSubagentRemove(opts, label);
      throw new UserError("Use: ./relay subagent create|list|remove");
    }
    case "image":
      return cmdImage(opts);
    case "token":
      return cmdToken(opts);
    case "env":
      return cmdEnv(opts);
    case "logout":
      return cmdLogout(opts);
    default:
      throw new UserError(`Unknown command "${command}". See ./relay help`);
  }
}

main().catch((err) => {
  if (err instanceof RevokedError) info(err.message);
  else if (err instanceof UserError) info(`error: ${err.message}`);
  else {
    info(`error: ${shortError(err)}`);
    if (process.env.DEBUG) console.error(err);
  }
  process.exitCode = 1;
});
