// Relay configuration, read from the environment (server only).
//
// Secrets never live on the config object: `keyFor()` reads provider keys on
// demand, the admin token is only reachable through `admin.check()` /
// `admin.cookie()` and the funder key through `funder.account()`, so logging
// or serializing a config can't leak one. Providers, their upstreams and key
// variables come from the catalog (catalog.ts).

import { createHmac, createHash, timingSafeEqual } from "node:crypto";

import { type Address, type LocalAccount, getAddress, isAddress, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { tryNormalize } from "../ens/names";
import { CATALOG, PROVIDER_IDS, type ProviderId, answeredByRelay, catalogEntry } from "./catalog";
import { DEFAULT_MAX_TOKEN_TTL_SEC } from "./token";

type Env = Record<string, string | undefined>;

/** Model -> [input $/MTok, output $/MTok, cached input $/MTok (optional)]. */
export type CodexPrices = Record<string, [number, number] | [number, number, number]>;

export type DnsAlias = { from: string; to: string };

/** An extra provider route the operator allows (RELAY_EXTRA_ROUTES). "metered" routes are charged like the provider's other paid calls. */
export type ExtraRoute = { provider: ProviderId; method: string; pattern: string; kind: "metered" | "free" };

/**
 * Who may read /api/relay/log and /api/relay/policy:
 * - "token": the admin (RELAY_ADMIN_TOKEN) or an agent for its own names
 * - "open": anyone (development without RELAY_ADMIN_TOKEN)
 * - "closed": only agents for their own names (production without RELAY_ADMIN_TOKEN)
 */
export type ViewAuth = "token" | "open" | "closed";

export type RelayConfig = {
  /** Normalized RELAY_ROOT_NAME, e.g. "acme.eth"; null when unset or invalid. */
  rootName: string | null;
  /** Set when RELAY_ROOT_NAME or RELAY_ROOT_OWNER is present but invalid; every call is refused. */
  rootError: string | null;
  /** RELAY_ROOT_OWNER: the only address the relay accepts as the root's owner (null = not pinned). */
  rootOwner: Address | null;
  rpcUrl: string;
  /** RPC for eth_getLogs scans (finding subnames): RELAY_LOGS_RPC_URL, else rpcUrl. Needs wide block ranges. */
  logsRpcUrl: string;
  /** Upstream base URL per provider (no trailing slash); null for mock or an invalid override. */
  upstreams: Record<ProviderId, string | null>;
  /** How often a call in flight re-checks that its name is still alive (ms); null = never (RELAY_LIVE_CHECK_SEC=0). */
  liveCheckMs: number | null;
  /** The gas funder for new members (POST /api/fund). The key itself is only reachable through `account()`. */
  funder: FunderConfig;
  dnsAlias: DnsAlias | null;
  requireCanonical: boolean;
  dataDir: string;
  codexPrices: CodexPrices;
  /** Public origin of this app, e.g. "http://localhost:3000". */
  publicUrl: string;
  /** Token audiences this relay accepts (origins). Tokens without an audience are accepted too. */
  audiences: string[];
  /** Longest token lifetime (exp - iat) the relay accepts, in seconds. */
  maxTokenTtlSec: number;
  /** Calls one name may have in flight at once. */
  maxConcurrent: number;
  /** Output-token limit the relay sets on generation requests that don't set one. */
  maxOutputTokens: number;
  extraRoutes: ExtraRoute[];
  viewAuth: ViewAuth;
  admin: {
    enabled: boolean;
    /** Constant-time check of a presented admin token. */
    check: (presented: string) => boolean;
    /** Value of the admin session cookie (an HMAC of the token, not the token). */
    cookie: () => string | null;
  };
  /** The real provider key, or null. Mock has no key. */
  keyFor: (provider: ProviderId) => string | null;
  /** True when the relay can serve this provider (key and upstream present). */
  isConfigured: (provider: ProviderId) => boolean;
};

export type FunderConfig = {
  /** FUNDER_PRIVATE_KEY is set and valid. */
  enabled: boolean;
  /** Set when FUNDER_PRIVATE_KEY is present but not a private key. */
  error: string | null;
  /** The funder wallet's address (public). */
  address: Address | null;
  /** What one grant pays, in ETH (FUNDER_AMOUNT_ETH, default "0.01"). Decimal strings keep the config JSON-safe. */
  amountEth: string;
  /** Only wallets below this balance are topped up (FUNDER_MIN_BALANCE_ETH, default "0.005"). */
  minBalanceEth: string;
  /** Most the funder pays per UTC day (FUNDER_DAILY_LIMIT_ETH, default "0.5"). */
  dailyLimitEth: string;
  /** The funder account (signs locally). Built on demand so the key never sits on the config. */
  account: () => LocalAccount | null;
};

export const DEFAULT_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
export const DEFAULT_MAX_CONCURRENT = 16;
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
export const DEFAULT_LIVE_CHECK_SEC = 5;

/** Environment variable holding each provider's key (null = none needed), from the catalog. */
export const KEY_ENV = Object.fromEntries(CATALOG.map((p) => [p.id, p.keyEnv])) as Record<ProviderId, string | null>;

/** "openai-images" -> "RELAY_UPSTREAM_OPENAI_IMAGES". */
export const upstreamEnvName = (id: ProviderId) => `RELAY_UPSTREAM_${id.toUpperCase().replace(/-/g, "_")}`;

const clean = (v: string | undefined) => (v ?? "").trim();

/** Parses an http(s) base URL, dropping query, hash and trailing slashes. */
export function parseBaseUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** "acme.com=acme.eth" -> { from: "acme.com", to: "acme.eth" }. */
export function parseDnsAlias(raw: string): DnsAlias | null {
  const [from, to, ...rest] = raw.split("=");
  if (rest.length || !from || !to) return null;
  const f = tryNormalize(from);
  const t = tryNormalize(to);
  return f && t && f !== t ? { from: f, to: t } : null;
}

/** Rewrites a name under `alias.from` to the same name under `alias.to` (x.acme.com -> x.acme.eth). */
export function applyDnsAlias(name: string, alias: DnsAlias | null): string {
  if (!alias) return name;
  if (name === alias.from) return alias.to;
  if (name.endsWith(`.${alias.from}`)) return `${name.slice(0, -alias.from.length)}${alias.to}`;
  return name;
}

export function parseCodexPrices(raw: string): CodexPrices {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: CodexPrices = {};
  for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3)) continue;
    if (!value.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) continue;
    out[model.toLowerCase()] = value as CodexPrices[string];
  }
  return out;
}

/**
 * "codex:POST /v1/responses/compact, claude:GET /v1/files/*=free" -> routes.
 * `*` matches one path segment. Invalid entries are skipped.
 */
export function parseExtraRoutes(raw: string): ExtraRoute[] {
  const out: ExtraRoute[] = [];
  for (const entry of raw.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean)) {
    const m = entry.match(/^([a-z][a-z0-9-]*):(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s=]*)(?:=(metered|free))?$/i);
    if (!m) continue;
    const provider = m[1].toLowerCase();
    if (!(PROVIDER_IDS as string[]).includes(provider)) continue;
    const target = catalogEntry(provider as ProviderId);
    if (answeredByRelay(target) || target.typedOnly) continue;
    out.push({ provider: provider as ProviderId, method: m[2].toUpperCase(), pattern: m[3].replace(/\/+$/, "") || "/", kind: (m[4]?.toLowerCase() as ExtraRoute["kind"]) ?? "metered" });
  }
  return out;
}

const positiveInt = (raw: string, fallback: number) => {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n > 0 ? n : fallback;
};

/** RELAY_LIVE_CHECK_SEC: seconds (fractions allowed, at least 0.05); 0 or "off" turns the check off. */
export function parseLiveCheck(raw: string): number | null {
  if (/^(0|off|false|no)$/i.test(raw)) return null;
  const n = Number(raw);
  const sec = raw && Number.isFinite(n) && n > 0 ? Math.max(n, 0.05) : DEFAULT_LIVE_CHECK_SEC;
  return Math.round(sec * 1000);
}

/** An ETH amount like "0.01" (at most 18 decimals); the fallback when unset or invalid. */
function ethAmount(raw: string, fallback: string): string {
  return /^\d{1,9}(\.\d{1,18})?$/.test(raw) ? raw : fallback;
}

function funderConfig(env: Env): FunderConfig {
  const raw = clean(env.FUNDER_PRIVATE_KEY);
  const key = raw && !raw.startsWith("0x") ? `0x${raw}` : raw;
  const valid = !!key && isHex(key) && key.length === 66;
  let address: Address | null = null;
  if (valid) {
    try {
      address = privateKeyToAccount(key as `0x${string}`).address;
    } catch {
      address = null;
    }
  }
  return {
    enabled: !!address,
    error: raw && !address ? "FUNDER_PRIVATE_KEY is not a private key (0x + 64 hex characters)" : null,
    address,
    amountEth: ethAmount(clean(env.FUNDER_AMOUNT_ETH), "0.01"),
    minBalanceEth: ethAmount(clean(env.FUNDER_MIN_BALANCE_ETH), "0.005"),
    dailyLimitEth: ethAmount(clean(env.FUNDER_DAILY_LIMIT_ETH), "0.5"),
    account: () => (address ? privateKeyToAccount(key as `0x${string}`) : null),
  };
}

/** Origins that name the same local server (a token made for localhost:3000 works at 127.0.0.1:3000). */
function withLocalAliases(origin: string): string[] {
  try {
    const url = new URL(origin);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return [origin];
    return ["localhost", "127.0.0.1", "[::1]"].map((h) => `${url.protocol}//${h}${url.port ? `:${url.port}` : ""}`);
  } catch {
    return [];
  }
}

function adminAuth(token: string): RelayConfig["admin"] {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return {
    enabled: !!token,
    check: (presented) => !!token && timingSafeEqual(digest(presented), digest(token)),
    cookie: () => (token ? createHmac("sha256", token).update("keyless-relay:admin-cookie:v1").digest("hex") : null),
  };
}

export function loadConfig(env: Env = process.env): RelayConfig {
  const rawRoot = clean(env.RELAY_ROOT_NAME);
  const rootName = rawRoot ? tryNormalize(rawRoot) : null;
  const rawOwner = clean(env.RELAY_ROOT_OWNER);
  const rootOwner = rawOwner && isAddress(rawOwner, { strict: false }) ? getAddress(rawOwner) : null;
  const rootError =
    rawRoot && !rootName
      ? `RELAY_ROOT_NAME "${rawRoot}" is not a valid ENS name`
      : rawOwner && !rootOwner
        ? `RELAY_ROOT_OWNER "${rawOwner}" is not an address`
        : null;

  // Upstreams come from the catalog; RELAY_UPSTREAM_<ID> overrides one (an invalid override disables it).
  const upstreams = Object.fromEntries(CATALOG.map((p) => [p.id, p.upstream])) as Record<ProviderId, string | null>;
  const railway = clean(env.RELAY_RAILWAY_URL);
  if (railway) upstreams.railway = parseBaseUrl(railway);
  for (const id of PROVIDER_IDS) {
    const entry = catalogEntry(id);
    if (entry.upstreamEnv) {
      // The account's own deployment (MULTIBAAS_URL): no catalog default.
      upstreams[id] = parseBaseUrl(clean(env[entry.upstreamEnv]));
      continue;
    }
    if (entry.upstream === null) continue; // answered by the relay itself (mock)
    const override = clean(env[upstreamEnvName(id)]);
    if (override) upstreams[id] = parseBaseUrl(override);
  }

  const keyFor = (provider: ProviderId) => {
    const name = KEY_ENV[provider];
    return name ? clean(env[name]) || null : null;
  };
  const isConfigured = (provider: ProviderId) => {
    const entry = catalogEntry(provider);
    if (answeredByRelay(entry)) return true;
    return !!upstreams[provider] && (entry.keyEnv === null || !!keyFor(provider));
  };

  const publicUrl = parseBaseUrl(clean(env.RELAY_PUBLIC_URL) || "http://localhost:3000") ?? "http://localhost:3000";
  const extraAudiences = clean(env.RELAY_AUDIENCES)
    .split(",")
    .map((s) => parseBaseUrl(s.trim()))
    .filter((s): s is string => !!s)
    .map((s) => new URL(s).origin);
  const admin = adminAuth(clean(env.RELAY_ADMIN_TOKEN));

  const rpcUrl = clean(env.RELAY_RPC_URL) || clean(env.NEXT_PUBLIC_SEPOLIA_RPC_URL) || DEFAULT_RPC_URL;
  return {
    rootName,
    rootError,
    rootOwner,
    rpcUrl,
    logsRpcUrl: clean(env.RELAY_LOGS_RPC_URL) || rpcUrl,
    upstreams,
    liveCheckMs: parseLiveCheck(clean(env.RELAY_LIVE_CHECK_SEC)),
    funder: funderConfig(env),
    dnsAlias: parseDnsAlias(clean(env.RELAY_DNS_ALIAS)),
    requireCanonical: !/^(0|false|no|off)$/i.test(clean(env.RELAY_REQUIRE_CANONICAL)),
    dataDir: clean(env.RELAY_DATA_DIR) || ".data",
    codexPrices: parseCodexPrices(clean(env.RELAY_CODEX_PRICES)),
    publicUrl,
    audiences: [...new Set([...withLocalAliases(new URL(publicUrl).origin), ...extraAudiences.flatMap(withLocalAliases)])],
    maxTokenTtlSec: positiveInt(clean(env.RELAY_MAX_TOKEN_TTL), DEFAULT_MAX_TOKEN_TTL_SEC),
    maxConcurrent: positiveInt(clean(env.RELAY_MAX_CONCURRENT), DEFAULT_MAX_CONCURRENT),
    maxOutputTokens: positiveInt(clean(env.RELAY_MAX_OUTPUT_TOKENS), DEFAULT_MAX_OUTPUT_TOKENS),
    extraRoutes: parseExtraRoutes(clean(env.RELAY_EXTRA_ROUTES)),
    viewAuth: admin.enabled ? "token" : clean(env.NODE_ENV) === "production" ? "closed" : "open",
    admin,
    keyFor,
    isConfigured,
  };
}

/** Config for the current process. Cheap, so it's re-read per request (env edits apply on restart or reload). */
export const getConfig = () => loadConfig(process.env);
