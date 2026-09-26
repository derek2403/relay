// Keyless Relay agent CLI: the agent side of the relay.
//
// An agent holds one key of its own and never a provider key. The level above
// gives it an ENS name (owner = the agent key, expiring); the agent signs short
// tokens for that name and sends them to the relay where a tool expects an API
// key. Run `npm run agent -- help` for the commands.
//
// Settings (flags win, then the environment, then .env.local / .env in this
// CLI's own repo, never the current directory: an agent often runs inside a
// checkout it doesn't trust, and a planted .env could send its token elsewhere):
//   --relay / KEYLESS_RELAY_URL   relay base URL (default <RELAY_PUBLIC_URL>/api/relay, else http://localhost:3000/api/relay)
//   --rpc   / RELAY_RPC_URL, NEXT_PUBLIC_SEPOLIA_RPC_URL   Sepolia RPC (default: public Sepolia RPC)
//   --key   / KEYLESS_KEY_FILE    agent key file (default <repo>/.keyless/agent.json)
//   KEYLESS_ADMIN_TOKEN           relay admin token, for "policy" on names this key doesn't own (environment only)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  encodeFunctionData,
  formatEther,
  http,
  isAddressEqual,
  isHex,
  parseAbi,
  zeroAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

// Relative imports (not "@/"), so the CLI also runs from outside the repo: tsx reads path aliases from the cwd's tsconfig.
import { ReverseRegistrarAdapterAbi } from "../lib/ens/abis/ReverseRegistrarAdapter";
import { ENSV2_SEPOLIA } from "../lib/ens/deployments";
import { formatError } from "../lib/ens/errors";
import { dnsEncode, labelId, namehash, splitFirst, tryNormalize } from "../lib/ens/names";
import { PROVIDER_IDS, describeBundle } from "../lib/relay/bundle";
import { DEFAULT_RPC_URL, applyDnsAlias, parseDnsAlias } from "../lib/relay/config";
import { UNIVERSAL_HELPER, statusFromCode } from "../lib/relay/ens";
import { DEFAULT_MAX_TOKEN_TTL_SEC, createToken } from "../lib/relay/token";
import type { LevelStatus, LevelView, LogEntry, PolicyResponse } from "../lib/relay/types";

// --- Output and errors ----------------------------------------------------------

/** A user-facing failure: printed as one line, no stack trace. */
class CliError extends Error {}

const info = (msg = "") => process.stderr.write(`${msg}\n`);
const out = (msg = "") => process.stdout.write(`${msg}\n`);

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  if (n === 0) return "$0";
  if (Math.abs(n) >= 1) return `$${n.toFixed(2).replace(/\.00$/, "")}`;
  const s = n.toFixed(6).replace(/0+$/, "");
  return `$${s.split(".")[1].length < 2 ? n.toFixed(2) : s}`;
}

// uint64 max (never expires) comes through JSON as ~1.8e19.
const fmtTime = (sec: number | null | undefined) =>
  !sec ? "-" : sec > 1e12 ? "never" : new Date(sec * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");

// --- Settings -------------------------------------------------------------------

/** The repo this CLI lives in (scripts/..), where its .env files and default key are. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Only these keys are read from .env files, so provider keys never enter this process.
const ENV_FILE_KEYS = ["RELAY_RPC_URL", "NEXT_PUBLIC_SEPOLIA_RPC_URL", "RELAY_PUBLIC_URL", "RELAY_DNS_ALIAS", "KEYLESS_RELAY_URL", "KEYLESS_KEY_FILE"];

function loadEnvFiles() {
  for (const file of [".env.local", ".env"]) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      // A variable already in the environment wins, even when set to "".
      if (!m || !ENV_FILE_KEYS.includes(m[1]) || m[1] in process.env) continue;
      const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
      // A key file named in the repo's .env is relative to the repo, not the current directory.
      if (value) process.env[m[1]] = m[1] === "KEYLESS_KEY_FILE" ? path.resolve(REPO_ROOT, value) : value;
    }
  }
}

/** Quotes a value for a POSIX shell (the env command's output is meant for eval). */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

type Opts = {
  name?: string;
  hours?: string;
  relay?: string;
  rpc?: string;
  key?: string;
  provider?: string;
  prompt?: string;
  model?: string;
  "max-tokens"?: string;
  json?: boolean;
  force?: boolean;
  help?: boolean;
};

/** The relay base URL, normalized (no credentials, query or trailing slash). */
const relayBase = (opts: Opts) => {
  const publicUrl = process.env.RELAY_PUBLIC_URL?.trim();
  const raw = opts.relay || process.env.KEYLESS_RELAY_URL || (publicUrl ? `${publicUrl.replace(/\/+$/, "")}/api/relay` : "http://localhost:3000/api/relay");
  let url: URL;
  try {
    url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    if (url.username || url.password) throw new Error();
  } catch {
    throw new CliError(`"${raw}" is not a valid relay URL (expected e.g. http://localhost:3000/api/relay)`);
  }
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/+$/, "");
};

/** The audience signed into tokens: the relay's origin, so a token sent to the wrong relay can't be replayed to the right one. */
const audienceOf = (base: string) => new URL(base).origin;

const rpcUrl = (opts: Opts) => opts.rpc || process.env.RELAY_RPC_URL || process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || DEFAULT_RPC_URL;

const isLocalRpc = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);

function publicClient(opts: Opts): PublicClient {
  return createPublicClient({ chain: sepolia, transport: http(rpcUrl(opts), { timeout: 20_000 }) }) as PublicClient;
}

function requireName(opts: Opts): string {
  if (!opts.name) throw new CliError("Add --name <ENS name>, e.g. --name laptop.derek.eng.acme.eth");
  const name = tryNormalize(opts.name);
  if (!name || !name.includes(".")) throw new CliError(`"${opts.name}" is not a valid ENS name`);
  return name;
}

function hoursOpt(opts: Opts, fallback: number): number {
  if (opts.hours === undefined) return fallback;
  const h = Number(opts.hours);
  if (!Number.isFinite(h) || h <= 0) throw new CliError(`--hours must be a positive number (got "${opts.hours}")`);
  return h;
}

// --- Agent key --------------------------------------------------------------------

type KeyFile = { address: Address; privateKey: Hex; createdAt: string };

const keyPath = (opts: Opts) => path.resolve(opts.key || process.env.KEYLESS_KEY_FILE || path.join(REPO_ROOT, ".keyless", "agent.json"));

function loadKey(opts: Opts) {
  const file = keyPath(opts);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new CliError(`No agent key at ${file}. Create one with: npm run agent -- new`);
  }
  let data: Partial<KeyFile>;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new CliError(`${file} is not valid JSON`);
  }
  if (typeof data.privateKey !== "string" || !isHex(data.privateKey) || data.privateKey.length !== 66) {
    throw new CliError(`${file} has no valid privateKey`);
  }
  try {
    if (process.platform !== "win32" && (fs.statSync(file).mode & 0o077) !== 0) {
      info(`warning: ${file} is readable by other users; run chmod 600 on it`);
    }
  } catch {}
  return { file, account: privateKeyToAccount(data.privateKey) };
}

function cmdNew(opts: Opts) {
  const file = keyPath(opts);
  if (fs.existsSync(file) && !opts.force) {
    const { account } = loadKey(opts);
    throw new CliError(
      `An agent key already exists at ${file} (${account.address}). It may own names, so it was kept. Use --force to replace it.`,
    );
  }
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const data: KeyFile = { address: account.address, privateKey, createdAt: new Date().toISOString() };
  // Write to a temp file first so a replaced key is never half-written.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  out(account.address);
  info(`Saved a new agent key to ${file} (only you can read it).`);
  info("Next: ask the level above you to start a session for this address, then run");
  info("  npm run agent -- env --name <session name>");
}

function cmdAddress(opts: Opts) {
  out(loadKey(opts).account.address);
}

// --- ENS reads --------------------------------------------------------------------

const helperAbi = parseAbi(["function findRegistries(bytes name) view returns (address[])"]);
const registryAbi = parseAbi([
  "function getState(uint256 anyId) view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource))",
  "function getResolver(string label) view returns (address)",
]);
const addrAbi = parseAbi(["function addr(bytes32 node) view returns (address)"]);

type NameState = { name: string; registry: Address | null; resolver: Address | null; status: LevelStatus; owner: Address | null; expiry: number | null };

const orNull = (a: Address | undefined | null) => (!a || isAddressEqual(a, zeroAddress) ? null : a);

/** The ENS state of a name: walks the registry tree from the root (one call), then reads its entry. */
async function readName(client: PublicClient, name: string, rpc: string): Promise<NameState> {
  try {
    const registries = await client.readContract({ address: UNIVERSAL_HELPER, abi: helperAbi, functionName: "findRegistries", args: [dnsEncode(name)] });
    // registries[i] is the subregistry of labels[i..], so [1] is the registry holding the leftmost label.
    const registry = orNull(registries[1]);
    if (!registry) return { name, registry: null, resolver: null, status: "missing", owner: null, expiry: null };
    const [label] = splitFirst(name);
    const [state, resolver] = await Promise.all([
      client.readContract({ address: registry, abi: registryAbi, functionName: "getState", args: [labelId(label)] }),
      client.readContract({ address: registry, abi: registryAbi, functionName: "getResolver", args: [label] }),
    ]);
    const status = statusFromCode(state.status);
    return {
      name,
      registry,
      resolver: orNull(resolver),
      status,
      owner: status === "registered" ? orNull(state.latestOwner) : null,
      expiry: state.expiry > 0n ? Number(state.expiry) : null,
    };
  } catch (err) {
    throw new CliError(`Could not read ENS from ${rpc}: ${shortError(err)}`);
  }
}

/** The name the relay will check (RELAY_DNS_ALIAS rewrites x.acme.com to x.acme.eth). */
const ensNameFor = (name: string) => applyDnsAlias(name, parseDnsAlias(process.env.RELAY_DNS_ALIAS ?? ""));

const STATUS_HELP: Record<Exclude<LevelStatus, "registered">, string> = {
  available: "is not registered (never registered, expired or removed)",
  reserved: "is reserved, not registered",
  missing: "can't be reached from the ENS root (a parent is missing or has no subname registry)",
};

const MAX_HOURS = DEFAULT_MAX_TOKEN_TTL_SEC / 3600;

/** Checks the agent key owns `name` right now and signs a token for it, for the relay at `base`. */
async function issueToken(opts: Opts, fallbackHours: number, base: string) {
  const name = requireName(opts);
  const asked = hoursOpt(opts, fallbackHours);
  // Relays refuse tokens that live longer than 24 h (RELAY_MAX_TOKEN_TTL).
  const hours = Math.min(asked, MAX_HOURS);
  if (asked > MAX_HOURS) info(`note: tokens last at most ${MAX_HOURS} h; signing one for ${MAX_HOURS} h`);
  const { account } = loadKey(opts);
  const rpc = rpcUrl(opts);
  const ensName = ensNameFor(name);
  const state = await readName(publicClient(opts), ensName, rpc);
  if (state.status !== "registered") {
    throw new CliError(`${ensName} ${STATUS_HELP[state.status]}. Ask the level above to start a session for ${account.address}.`);
  }
  if (!state.owner || !isAddressEqual(state.owner, account.address)) {
    throw new CliError(`${ensName} is owned by ${state.owner ?? "nobody"}, not this agent key (${account.address}). The relay would refuse the token.`);
  }
  const now = Math.floor(Date.now() / 1000);
  const wanted = now + Math.round(hours * 3600);
  // Tokens never outlive the name: ENS expiry is the session end.
  const exp = state.expiry && state.expiry < wanted ? state.expiry : wanted;
  if (exp <= now + 5) throw new CliError(`The session for ${ensName} has ended (expired ${fmtTime(state.expiry)}).`);
  const token = await createToken(account, { name, iat: now, exp, aud: audienceOf(base) });
  return { name, token, exp, cappedByEns: exp !== wanted, account, state };
}

async function cmdToken(opts: Opts) {
  const base = relayBase(opts);
  const t = await issueToken(opts, 8, base);
  out(t.token);
  info(`Token for ${t.name} at ${audienceOf(base)}, valid until ${fmtTime(t.exp)}${t.cappedByEns ? " (the session's ENS expiry)" : ""}.`);
}

async function cmdEnv(opts: Opts) {
  const base = relayBase(opts);
  const t = await issueToken(opts, 8, base);
  info(`# ${t.name} via ${base}, valid until ${fmtTime(t.exp)}${t.cappedByEns ? " (session end)" : ""}`);
  info(`# Load it with: eval "$(npm run -s agent -- env --name ${shellQuote(t.name)})"`);
  out(`export ANTHROPIC_BASE_URL=${shellQuote(`${base}/claude`)}`);
  out(`export ANTHROPIC_API_KEY=${shellQuote(t.token)}`);
  out(`export OPENAI_BASE_URL=${shellQuote(`${base}/codex/v1`)}`);
  out(`export OPENAI_API_KEY=${shellQuote(t.token)}`);
}

// --- Relay HTTP ---------------------------------------------------------------------

type HttpResult = { status: number; headers: Headers; text: string; json: unknown };

async function relayFetch(url: string, init: RequestInit = {}): Promise<HttpResult> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(180_000) });
  } catch (err) {
    const why = err instanceof Error && err.name === "TimeoutError" ? "timed out" : shortError(err);
    throw new CliError(`Could not reach the relay at ${new URL(url).origin} (${why}). Is it running (npm run dev)?`);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, text, json };
}

/** The relay's own error body ({ error, reason }), if that's what came back. */
function relayError(json: unknown): { error: string; reason?: string } | null {
  const j = json as { error?: unknown; reason?: unknown } | null;
  return j && typeof j.error === "string" ? { error: j.error, reason: typeof j.reason === "string" ? j.reason : undefined } : null;
}

/**
 * Credentials for reading /policy and /log: the admin token from the
 * environment, else an agent token (which only sees its own names).
 */
function viewHeaders(token: string | null): Record<string, string> {
  const admin = process.env.KEYLESS_ADMIN_TOKEN?.trim();
  if (admin) return { authorization: `Bearer ${admin}` };
  return token ? { "x-api-key": token } : {};
}

async function getPolicy(base: string, name: string, provider: string | null, token: string | null = null): Promise<PolicyResponse> {
  const q = new URLSearchParams({ name });
  if (provider) q.set("provider", provider);
  const r = await relayFetch(`${base}/policy?${q}`, { headers: viewHeaders(token) });
  const err = relayError(r.json);
  if (r.status !== 200 || !r.json || err) {
    throw new CliError(`The relay answered ${r.status}: ${err ? `${err.error}${err.reason ? ` (${err.reason})` : ""}` : r.text.slice(0, 200)}`);
  }
  return r.json as PolicyResponse;
}

function printLevels(levels: LevelView[], provider: string | null) {
  const mark = (v: boolean | null) => (v === null ? "-" : v ? "ok" : "FAIL");
  for (const l of levels) {
    info(`  ${l.status === "registered" ? "•" : "x"} ${l.name}  [${l.status}]`);
    info(`      bundle   ${describeBundle(l.bundle)}`);
    const spent = Object.entries(l.spent)
      .filter(([p, v]) => (provider ? p === provider : (v ?? 0) > 0))
      .map(([p, v]) => `${p} ${fmtUsd(v)}`);
    if (spent.length) info(`      spent    ${spent.join(" · ")}${l.bundle ? ` (this ${l.bundle.period === "total" ? "session" : l.bundle.period})` : ""}`);
    info(`      owner    ${l.owner ?? "-"}   expires ${fmtTime(l.expiry)}`);
    info(`      checks   registry ${mark(l.checks.registryVerified)} · resolver ${mark(l.checks.resolverVerified)} · canonical ${mark(l.checks.canonical)}`);
  }
}

async function cmdPolicy(opts: Opts) {
  const name = requireName(opts);
  const provider = opts.provider ?? null;
  if (provider && !(PROVIDER_IDS as string[]).includes(provider)) {
    throw new CliError(`Unknown provider "${provider}". Use one of: ${PROVIDER_IDS.join(", ")}`);
  }
  const base = relayBase(opts);
  // With this key's own token when it owns the name (the relay shows agents only their own names).
  let token: string | null = null;
  if (!process.env.KEYLESS_ADMIN_TOKEN?.trim()) token = await issueToken({ ...opts, hours: "0.1" }, 0.1, base).then((t) => t.token, () => null);
  const p = await getPolicy(base, name, provider, token);
  if (opts.json) {
    out(JSON.stringify(p, null, 2));
    return;
  }
  info(`Relay ${base} · root ${p.root || "(not set)"}`);
  if (provider) {
    out(p.allowed ? `${p.name} may use ${provider}: allowed` : `${p.name} may use ${provider}: refused (${p.reason})`);
    if (p.allowed) info(`Remaining budget: ${p.remaining === null ? "no cap" : fmtUsd(p.remaining)} (smallest cap left across levels)`);
  } else {
    out(`${p.name}${p.reason && !/no provider given/.test(p.reason) ? `: ${p.reason}` : ""}`);
    info("Add --provider <id> for a yes/no answer.");
  }
  if (p.levels.length) {
    info("Levels, root first:");
    printLevels(p.levels, provider);
  }
}

const DEFAULT_MODELS: Record<string, string> = { mock: "mock", claude: "claude-opus-5", codex: "gpt-5" };

function buildCall(provider: string, base: string, token: string, opts: Opts): { url: string; init: RequestInit } {
  const prompt = opts.prompt ?? "Say hello in five words.";
  const model = opts.model ?? DEFAULT_MODELS[provider];
  const maxTokens = Number(opts["max-tokens"] ?? 1024);
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new CliError(`--max-tokens must be a positive integer`);
  const json = (headers: Record<string, string>, body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const messages = [{ role: "user", content: prompt }];
  switch (provider) {
    case "mock":
      return { url: `${base}/mock/v1/messages`, init: json({ "x-api-key": token }, { model, max_tokens: maxTokens, messages }) };
    case "claude":
      // Same request Claude Code makes: the token goes where the API key would.
      return {
        url: `${base}/claude/v1/messages`,
        init: json({ "x-api-key": token, "anthropic-version": "2023-06-01" }, { model, max_tokens: maxTokens, messages }),
      };
    case "codex":
      return { url: `${base}/codex/v1/responses`, init: json({ authorization: `Bearer ${token}` }, { model, input: prompt }) };
    case "github":
      return { url: `${base}/github/user`, init: { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } } };
    default:
      throw new CliError(`call supports mock, claude, codex and github (got "${provider}")`);
  }
}

/** The human-readable part of a provider response. */
function replyText(provider: string, json: unknown): string | null {
  const j = json as Record<string, unknown> | null;
  if (!j) return null;
  if (provider === "mock" || provider === "claude") {
    const content = Array.isArray(j.content) ? (j.content as { type?: string; text?: string }[]) : [];
    const text = content.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n");
    return text || (j.stop_reason ? `(no text; stop_reason ${String(j.stop_reason)})` : null);
  }
  if (provider === "codex") {
    const output = Array.isArray(j.output) ? (j.output as { content?: { type?: string; text?: string }[] }[]) : [];
    return output.flatMap((o) => o.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text).join("\n") || null;
  }
  if (provider === "github") return typeof j.login === "string" ? `signed in to GitHub as ${j.login}` : null;
  return null;
}

async function cmdCall(opts: Opts) {
  const provider = opts.provider ?? "mock";
  if (!(provider in DEFAULT_MODELS) && provider !== "github") throw new CliError(`call supports mock, claude, codex and github (got "${provider}")`);
  const base = relayBase(opts);
  const t = await issueToken(opts, 1, base);
  const { url, init } = buildCall(provider, base, t.token, opts);
  const startedAt = Date.now();
  info(`→ ${init.method} ${url} as ${t.name}`);
  const r = await relayFetch(url, init);
  const ok = r.status >= 200 && r.status < 300;
  const err = relayError(r.json);
  if (ok) {
    out(`← ${r.status} allowed`);
    const text = replyText(provider, r.json);
    if (text) out(text);
  } else if (err) {
    out(`← ${r.status} refused by the relay: ${err.reason ?? err.error}`);
  } else {
    const upstream = (r.json as { error?: { message?: string } | string } | null)?.error;
    const msg = typeof upstream === "string" ? upstream : upstream?.message;
    out(`← ${r.status} from ${provider}: ${msg ?? r.text.slice(0, 300)}`);
  }
  for (const h of ["request-id", "x-request-id", "x-github-request-id"]) {
    const v = r.headers.get(h);
    if (v) info(`  ${h}: ${v}`);
  }

  // What it cost: the relay charges when the provider finishes and logs the result (this token sees its own entries).
  try {
    const log = await relayFetch(`${base}/log?limit=50`, { headers: viewHeaders(t.token) });
    const entries = Array.isArray(log.json) ? (log.json as LogEntry[]) : [];
    const mine = entries.find((e) => e.provider === provider && e.ts >= startedAt - 2000 && e.name === ensNameFor(t.name));
    if (mine?.allowed) {
      info(`  cost: ${mine.costUsd === null ? "not metered" : `${fmtUsd(mine.costUsd)}${mine.estimated ? " (estimated)" : ""}`}`);
    }
    if (ok) {
      const p = await getPolicy(base, t.name, provider, t.token);
      info(`  next call: ${p.allowed ? `allowed, ${p.remaining === null ? "no cap" : `${fmtUsd(p.remaining)} left`}` : `refused (${p.reason})`}`);
    }
  } catch {
    // Cost details are a nice-to-have; the call itself already printed.
  }
  if (opts.json) out(r.text);
  if (!ok) process.exitCode = 1;
}

// --- Primary name ---------------------------------------------------------------------

// ENSv1 reverse registrar (primary names are still ENSv1 at launch).
const reverseRegistrarAbi = parseAbi([
  "function setName(string name) returns (bytes32)",
  "function node(address addr) pure returns (bytes32)",
  "function defaultResolver() view returns (address)",
]);
const nameAbi = parseAbi(["function name(bytes32 node) view returns (string)"]);
const resolveAbi = parseAbi(["function resolve(bytes name, bytes data) view returns (bytes)"]);
const FALLBACK_REVERSE_REGISTRAR: Address = "0xA0a1AbcDAe1a2a4A2EF8e9113Ff0e02DD81DC0C6";

async function cmdPrimaryName(opts: Opts) {
  const name = requireName(opts);
  const { account } = loadKey(opts);
  const rpc = rpcUrl(opts);
  const client = publicClient(opts);
  const state = await readName(client, name, rpc);
  if (state.status !== "registered") throw new CliError(`${name} ${STATUS_HELP[state.status]}.`);
  if (!state.owner || !isAddressEqual(state.owner, account.address)) {
    info(`warning: ${name} is owned by ${state.owner}, not this agent key.`);
  }

  // It only displays if the name forward-resolves to this address.
  let forward: Address | null = null;
  if (state.resolver) {
    try {
      const raw = await client.readContract({
        address: state.resolver,
        abi: resolveAbi,
        functionName: "resolve",
        args: [dnsEncode(name), encodeFunctionData({ abi: addrAbi, functionName: "addr", args: [namehash(name)] })],
      });
      forward = orNull(decodeAbiParameters([{ type: "address" }], raw)[0]);
    } catch {}
  }
  if (!forward || !isAddressEqual(forward, account.address)) {
    info(`warning: ${name} resolves to ${forward ?? "no address"}, not ${account.address}; wallets won't show the primary name until it does.`);
  }

  const balance = await client.getBalance({ address: account.address }).catch((err) => {
    throw new CliError(`Could not read the balance from ${rpc}: ${shortError(err)}`);
  });
  if (balance === 0n) throw new CliError(`The agent key ${account.address} has no Sepolia ETH. Send it about 0.001 ETH for gas, then try again.`);

  const registrar = await client
    .readContract({ address: ENSV2_SEPOLIA.ReverseRegistrarAdapter.address, abi: ReverseRegistrarAdapterAbi, functionName: "REVERSE_REGISTRAR" })
    .catch(() => FALLBACK_REVERSE_REGISTRAR);
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpc) });
  let hash: Hex;
  try {
    const { request } = await client.simulateContract({ account, address: registrar, abi: reverseRegistrarAbi, functionName: "setName", args: [name] });
    hash = await wallet.writeContract(request);
  } catch (err) {
    throw new CliError(`setName failed: ${formatError(err)}${balance < 10n ** 15n ? ` (balance ${formatEther(balance)} ETH may be too low)` : ""}`);
  }
  info(`Sent setName("${name}") from ${account.address}: ${hash}`);
  if (!isLocalRpc(rpc)) info(`  https://sepolia.etherscan.io/tx/${hash}`);
  // Polled directly: waitForTransactionReceipt can miss an automined transaction on a local fork.
  let receipt: TransactionReceipt | null = null;
  for (let i = 0; !receipt && i < 180; i++) {
    receipt = await client.getTransactionReceipt({ hash }).catch(() => null);
    if (!receipt) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!receipt) throw new CliError(`Sent ${hash}, but it wasn't mined within 3 minutes. Check it on a block explorer.`);
  if (receipt.status !== "success") throw new CliError(`The transaction reverted: ${hash}`);

  let now = "";
  try {
    const [resolver, node] = await Promise.all([
      client.readContract({ address: registrar, abi: reverseRegistrarAbi, functionName: "defaultResolver" }),
      client.readContract({ address: registrar, abi: reverseRegistrarAbi, functionName: "node", args: [account.address] }),
    ]);
    now = await client.readContract({ address: resolver, abi: nameAbi, functionName: "name", args: [node] });
  } catch {}
  out(now ? `Primary name of ${account.address} is now ${now}` : `Primary name set for ${account.address}`);
}

// --- Main -------------------------------------------------------------------------------

const HELP = `Keyless Relay agent CLI

Usage: npm run agent -- <command> [options]

Commands
  new                           Create an agent key (.keyless/agent.json) and print its address
  address                       Print the agent key's address
  token  --name N [--hours H]   Print a relay token for N (default 8 h, at most 24 h, never past the session end)
  env    --name N [--relay URL] Print export lines for Claude Code and Codex
  call   --name N [--provider mock|claude|codex|github] [--prompt "..."] [--model M]
                                Send one request through the relay; prints the decision and cost
  policy --name N [--provider P] [--json]
                                Show what the relay would decide for N right now
  primary-name --name N         Set N as this key's primary name (needs a little Sepolia ETH)

Options
  --relay URL   Relay base URL (default http://localhost:3000/api/relay, or KEYLESS_RELAY_URL)
  --rpc URL     Sepolia RPC (default RELAY_RPC_URL, NEXT_PUBLIC_SEPOLIA_RPC_URL, or a public RPC)
  --key FILE    Agent key file (default .keyless/agent.json in this repo, or KEYLESS_KEY_FILE)

Settings come from flags, the environment, then .env.local / .env in this CLI's
repo (never the current directory). Tokens are bound to the relay's origin.
  --force       With new: replace an existing key

Example
  npm run agent -- new
  eval "$(npm run -s agent -- env --name laptop.derek.eng.acme.eth)"
  claude   # Claude Code now goes through the relay`;

function shortError(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return (e?.shortMessage || e?.message || String(err)).split("\n")[0];
}

async function main() {
  loadEnvFiles();
  let parsed: { values: Opts; positionals: string[] };
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        name: { type: "string", short: "n" },
        hours: { type: "string" },
        relay: { type: "string" },
        rpc: { type: "string" },
        key: { type: "string" },
        provider: { type: "string", short: "p" },
        prompt: { type: "string" },
        model: { type: "string" },
        "max-tokens": { type: "string" },
        json: { type: "boolean" },
        force: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }) as { values: Opts; positionals: string[] };
  } catch (err) {
    throw new CliError(`${(err instanceof Error ? err.message : String(err)).replace(/\.+$/, "")}. See: npm run agent -- help`);
  }
  const { values: opts, positionals } = parsed;
  const [command, ...extra] = positionals;
  if (!command || command === "help" || opts.help) {
    out(HELP);
    return;
  }
  if (extra.length) throw new CliError(`Unexpected argument "${extra[0]}". Options need a flag, e.g. --name ${extra[0]}`);

  const commands: Record<string, (o: Opts) => unknown> = {
    new: cmdNew,
    address: cmdAddress,
    token: cmdToken,
    env: cmdEnv,
    call: cmdCall,
    policy: cmdPolicy,
    "primary-name": cmdPrimaryName,
  };
  const run = commands[command];
  if (!run) throw new CliError(`Unknown command "${command}". See: npm run agent -- help`);
  await run(opts);
}

main().catch((err) => {
  if (err instanceof CliError) {
    info(`error: ${err.message}`);
  } else {
    info(`error: ${shortError(err)}`);
    if (process.env.DEBUG) console.error(err);
  }
  // exitCode rather than exit(): piped output on macOS is written asynchronously.
  process.exitCode = 1;
});
