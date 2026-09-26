// Browser-side helpers for the admin app: agent keys kept in this browser,
// access tokens, calldata for bundle writes, record reads and relay API fetchers.
// No React here; the hooks in lib/hooks/useRelay*.ts wrap these.

import {
  type Address,
  type Hex,
  type PublicClient,
  decodeAbiParameters,
  encodeFunctionData,
  isAddress,
  isAddressEqual,
  parseAbi,
  zeroAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { PermissionedResolverImplAbi } from "@/lib/ens/abis/PermissionedResolverImpl";
import { addresses } from "@/lib/ens/contracts";
import { dnsEncode, namehash } from "@/lib/ens/names";

import {
  type Bundle,
  PROVIDERS,
  PROVIDER_IDS,
  type Period,
  type ProviderId,
  RECORD_PREFIX,
  bundleRecordKeys,
  bundleToRecords,
  parseBundle,
} from "./bundle";
import { catalogEntry, countUnit } from "./catalog";
import { DEFAULT_MAX_TOKEN_TTL_SEC, createToken } from "./token";
import type { ChildView, ChildrenResponse, FundResponse, LevelStatus, LogEntry, PolicyResponse, RelayError, StatusResponse } from "./types";

// --- Agent keys -------------------------------------------------------------

/** localStorage key holding agent keys generated in this browser. */
export const AGENT_KEYS_STORAGE = "keyless-relay:agent-keys";

export type StoredAgentKey = {
  address: Address;
  privateKey: Hex;
  /** Name the key was created for (informational; ENS ownership is the truth). */
  name?: string;
  createdAt: number;
};

export function newAgentKey(name?: string): StoredAgentKey {
  const privateKey = generatePrivateKey();
  return { address: privateKeyToAccount(privateKey).address, privateKey, name, createdAt: Date.now() };
}

/** Shown next to "generate a key": the private key sits in localStorage as plain text. */
export const DEMO_KEY_WARNING = "Kept unencrypted in this browser. Agents that run on their own machine should use their own key.";

// Names are ERC-1155 tokens: minting to an address with code calls onERC1155Received on it,
// and a contract that doesn't implement it makes register revert (ERC1155InvalidReceiver).
export const CONTRACT_OWNER_WARNING =
  "This address is a contract or smart wallet; it may not be able to hold a name. Use a normal wallet address.";

/** The relay CLI (scripts/relay.ts, installed as `relay`) on the user's laptop: `--as` takes the agent's or a subagent's label. */
export const relayTokenCommand = (name: string) => `relay token --as ${name.split(".")[0]}`;
/** Export lines for Codex and OpenAI SDKs, from the same CLI keys. */
export const relayEnvCommand = (name: string) => `eval "$(relay env --as ${name.split(".")[0]})"`;

/** Agent CLI commands (scripts/agent.ts) for an agent that keeps its own key. */
export const AGENT_CLI = {
  /** Creates the agent's key file and prints its address. */
  newKey: "npm run agent -- new",
  /** Sets base URLs and a fresh token (signed by the agent's key) for Claude Code and Codex. */
  env: (name: string, relay?: string) => `eval "$(npm run -s agent -- env --name ${name}${relay ? ` --relay ${relay}` : ""})"`,
};

export const findAgentKey = (keys: StoredAgentKey[], address: Address | null | undefined) =>
  address ? keys.find((k) => isAddressEqual(k.address, address)) : undefined;

export const agentAccount = (key: StoredAgentKey) => privateKeyToAccount(key.privateKey);

/**
 * A relay token for `name`, signed by the agent key. It expires at `expiry`
 * (unix seconds) or after `maxTtlSec`, whichever is first: the relay refuses
 * tokens that live longer than RELAY_MAX_TOKEN_TTL (24 h by default).
 */
export function agentToken(key: StoredAgentKey, name: string, expiry: number, maxTtlSec = DEFAULT_MAX_TOKEN_TTL_SEC): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  return createToken(agentAccount(key), { name, iat, exp: Math.min(expiry, iat + maxTtlSec) });
}

// --- Bundle writes ------------------------------------------------------------

/**
 * Extra text record written only on plan bundles. Linking a member to a plan
 * shares the plan's whole record, so a member that reads a non-empty
 * `relay.plan` is linked. The relay ignores it.
 */
export const PLAN_KEY = `${RECORD_PREFIX}.plan`;

export const planName = (slug: string, parent: string) => `plan-${slug}.${parent}`;

export const encodeSetText = (name: string, key: string, value: string): Hex =>
  encodeFunctionData({ abi: PermissionedResolverImplAbi, functionName: "setText", args: [dnsEncode(name), key, value] });

/**
 * Calls (for the resolver's multicall) that write `bundle` for `name`.
 * - `unlink`: first detach the name from a shared plan record, otherwise the
 *   setText calls would edit the plan for every member linked to it.
 * - `agent`: also point the name's ETH address at the agent key, so the name
 *   forward-resolves (needed for a primary name).
 * - `plan`: tag the record as a plan (see PLAN_KEY).
 */
export function bundleCalls(
  name: string,
  bundle: Bundle,
  opts: { unlink?: boolean; agent?: Address; plan?: string } = {},
): Hex[] {
  const dns = dnsEncode(name);
  const calls: Hex[] = [];
  if (opts.unlink) {
    calls.push(encodeFunctionData({ abi: PermissionedResolverImplAbi, functionName: "linkToRecord", args: [dns, 0n] }));
  }
  for (const [key, value] of bundleToRecords(bundle)) calls.push(encodeSetText(name, key, value));
  if (opts.plan) calls.push(encodeSetText(name, PLAN_KEY, opts.plan));
  if (opts.agent) {
    calls.push(encodeFunctionData({ abi: PermissionedResolverImplAbi, functionName: "setAddress", args: [dns, 60n, opts.agent] }));
  }
  return calls;
}

// --- Record reads -------------------------------------------------------------

const recordAbi = parseAbi([
  "function text(bytes32 node, string key) view returns (string)",
  "function multicall(bytes[] data) returns (bytes[] results)",
]);

/**
 * Reads text records in one call: PermissionedResolver.resolve accepts a
 * multicall of text() calls and returns the abi-encoded bytes[] of results.
 */
export async function readTexts(client: PublicClient, resolver: Address, name: string, keys: string[]) {
  const node = namehash(name);
  const calls = keys.map((key) => encodeFunctionData({ abi: recordAbi, functionName: "text", args: [node, key] }));
  const raw = await client.readContract({
    address: resolver,
    abi: PermissionedResolverImplAbi,
    functionName: "resolve",
    args: [dnsEncode(name), encodeFunctionData({ abi: recordAbi, functionName: "multicall", args: [calls] })],
  });
  const [results] = decodeAbiParameters([{ type: "bytes[]" }], raw);
  const texts: Record<string, string> = {};
  keys.forEach((key, i) => {
    const r = results[i];
    texts[key] = r && r !== "0x" ? decodeAbiParameters([{ type: "string" }], r)[0] : "";
  });
  return texts;
}

export type BundleRead = { bundle: Bundle | null; plan: string | null; texts: Record<string, string> };

export async function readBundle(client: PublicClient, resolver: Address, name: string): Promise<BundleRead> {
  const texts = await readTexts(client, resolver, name, [...bundleRecordKeys(), PLAN_KEY]);
  return { bundle: parseBundle(texts), plan: texts[PLAN_KEY] || null, texts };
}

// --- Relay API ------------------------------------------------------------------

export class RelayApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public reason?: string,
  ) {
    super(message);
  }
}

/** An error for display, with the relay's `reason` when it sent one ("ENS read failed: rate limited"). */
export const errorText = (err: Error) => (err instanceof RelayApiError && err.reason ? `${err.message}: ${err.reason}` : err.message);

export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON (e.g. a Next.js 404 page while the route doesn't exist yet).
  }
  if (!res.ok) {
    const err = body as RelayError | null;
    const message = err?.error ?? (res.status === 404 ? `${url.split("?")[0]} not found` : `HTTP ${res.status}`);
    throw new RelayApiError(message, res.status, err?.reason);
  }
  return body as T;
}

const q = encodeURIComponent;

export const relayApi = {
  status: () => getJson<StatusResponse>("/api/relay/status"),
  policy: (name: string, provider?: string) =>
    getJson<PolicyResponse>(`/api/relay/policy?name=${q(name)}${provider ? `&provider=${q(provider)}` : ""}`),
  log: (limit = 20) => getJson<LogEntry[]>(`/api/relay/log?limit=${limit}`),
  children: (name: string) => getJson<ChildrenResponse>(`/api/ens/children?name=${q(name)}`),
  /**
   * Tops up a newly added member's wallet with a little Sepolia ETH from the relay's funder.
   * Refusals (no funder, rate limited, …) come back as `{ funded: false, reason }` with an error
   * status; they're returned as answers, not thrown.
   */
  fund: async (name: string): Promise<FundResponse> => {
    const res = await fetch("/api/fund", {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const body = (await res.json().catch(() => null)) as (Partial<FundResponse> & RelayError) | null;
    if (body && typeof body.funded === "boolean") return body as FundResponse;
    throw new RelayApiError(body?.error ?? (res.status === 404 ? "/api/fund not found" : `HTTP ${res.status}`), res.status, body?.reason);
  },
};

/** GET /api/relay/status also reports the gas funder (not part of the shared StatusResponse type). */
export type FunderStatus = { enabled: boolean; address: string | null; amountEth: string; error: string | null };
export const funderOf = (status: StatusResponse | undefined): FunderStatus | null =>
  (status as (StatusResponse & { funder?: FunderStatus }) | undefined)?.funder ?? null;

/** True when a relay read failed because the admin isn't signed in (RELAY_ADMIN_TOKEN is set). */
export const needsSignIn = (err: unknown) => err instanceof RelayApiError && err.status === 401;

/** The relay's admin sign-in page (a route handler, so it needs a full page load). */
export const ADMIN_SIGN_IN = "/api/relay/admin";

// --- Snippets -------------------------------------------------------------------

export function tokenSnippets(baseUrl: string, token: string) {
  return [
    {
      label: "Check it: one Codex call",
      text: [
        `curl -s ${baseUrl}/codex/v1/chat/completions \\`,
        `  -H "authorization: Bearer ${token}" \\`,
        `  -H "content-type: application/json" \\`,
        `  -d '{"model":"gpt-5.4-mini","messages":[{"role":"user","content":"Say hi in five words."}]}'`,
      ].join("\n"),
    },
    { label: "Claude Code", text: `ANTHROPIC_BASE_URL=${baseUrl}/claude ANTHROPIC_API_KEY=${token} claude` },
    { label: "Codex / OpenAI SDKs", text: `OPENAI_BASE_URL=${baseUrl}/codex/v1 OPENAI_API_KEY=${token} codex` },
  ];
}

export type SampleRequest = { method: string; path: string; body: string | null; auth: "x-api-key" | "bearer" };

/** The request "Try a call" starts from for a provider (a plain GET for APIs without a sample). */
export const sampleRequest = (provider: string): SampleRequest => SAMPLE_REQUESTS[provider] ?? { method: "GET", path: "/", body: null, auth: "bearer" };

/** A request per provider that "Try a call" starts from; the user can edit it. */
export const SAMPLE_REQUESTS: Record<string, SampleRequest> = {
  mock: {
    method: "POST",
    path: "/v1/messages",
    body: JSON.stringify({ model: "mock", max_tokens: 64, messages: [{ role: "user", content: "Hello from Keyless Relay" }] }, null, 2),
    auth: "x-api-key",
  },
  claude: {
    method: "POST",
    path: "/v1/messages",
    body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 64, messages: [{ role: "user", content: "Say hi in five words." }] }, null, 2),
    auth: "x-api-key",
  },
  codex: {
    method: "POST",
    path: "/v1/chat/completions",
    body: JSON.stringify({ model: "gpt-5.4-mini", messages: [{ role: "user", content: "Say hi in five words." }] }, null, 2),
    auth: "bearer",
  },
  "openai-images": {
    method: "POST",
    path: "/v1/images/generations",
    body: JSON.stringify({ model: "gpt-image-1-mini", prompt: "A small red torii gate, flat illustration", n: 1, size: "1024x1024" }, null, 2),
    auth: "bearer",
  },
  github: { method: "GET", path: "/user", body: null, auth: "bearer" },
  railway: { method: "POST", path: "/graphql/v2", body: JSON.stringify({ query: "{ me { name email } }" }, null, 2), auth: "bearer" },
};

// --- Durations and formatting -----------------------------------------------------

export const SESSION_DURATIONS = [
  { label: "15 min", seconds: 15 * 60 },
  { label: "1 hour", seconds: 60 * 60 },
  { label: "8 hours", seconds: 8 * 60 * 60 },
] as const;

export const MEMBER_DURATIONS = [
  { label: "30 days", seconds: 30 * 86400 },
  { label: "90 days", seconds: 90 * 86400 },
  { label: "1 year", seconds: 365 * 86400 },
] as const;

export const EXTEND_BY = [
  { label: "+1 hour", seconds: 3600 },
  { label: "+8 hours", seconds: 8 * 3600 },
  { label: "+30 days", seconds: 30 * 86400 },
  { label: "+1 year", seconds: 365 * 86400 },
] as const;

export const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * "Now" for new expiries: the later of this computer's clock and the latest
 * block, so a slow clock can't produce an expiry the registry sees as past
 * (register reverts with CannotSetPastExpiry).
 */
export async function chainNow(client: PublicClient): Promise<number> {
  try {
    const block = await client.getBlock();
    return Math.max(nowSec(), Number(block.timestamp));
  } catch {
    return nowSec();
  }
}

export const usd = (n: number) => `$${n < 1 && n > 0 ? n.toFixed(3).replace(/0$/, "") : n.toFixed(2)}`;

/** "2h 05m", "3d 4h", "45s". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** Expiries past what a Date can hold (e.g. max uint64) mean "never expires". */
export const isNever = (unix: number) => unix > 8.64e12;

export const formatDate = (unix: number) => (isNever(unix) ? "never" : new Date(unix * 1000).toLocaleString());

// --- The tree -----------------------------------------------------------------------

/** What each depth of the tree is, counted from the company root (always a .eth name). */
export const ROLES = ["company", "department", "team", "user", "agent", "subagent"] as const;
export type Role = (typeof ROLES)[number];

/** Depth below the company root: acme.eth 0, eng.acme.eth 1, dev.eng.acme.eth 2, … */
export const depthOf = (name: string) => Math.max(0, name.split(".").length - 2);

export const roleOf = (name: string): Role => ROLES[Math.min(depthOf(name), ROLES.length - 1)];

/** "dev.eng.acme.eth" -> "eng.acme.eth". */
export const parentOf = (name: string) => name.slice(name.indexOf(".") + 1);

/** Every name from the company root down to `name`: ["acme.eth", "eng.acme.eth", "dev.eng.acme.eth"]. */
export function chainNames(name: string): string[] {
  const labels = name.split(".");
  const out: string[] = [];
  for (let i = labels.length - 2; i >= 0; i--) out.push(labels.slice(i).join("."));
  return out;
}

/** The user (depth 3) a name belongs to, or null above that depth. */
export function userOf(name: string): string | null {
  const chain = chainNames(name);
  return chain.length > 3 ? chain[3] : null;
}

/**
 * Tree badge for a name that isn't registered. unregister clears the entry's
 * latestOwner; a name that ran out keeps it (and its expiry). Null state: not read yet.
 */
export function inactiveLabel(role: Role, state: { latestOwner: Address; expiry: bigint } | null | undefined): string {
  if (role === "company") return "not registered";
  if (!state) return "not live";
  return state.latestOwner !== zeroAddress && state.expiry > 0n ? "ended" : "removed";
}

// --- Live view ----------------------------------------------------------------------

export type LiveState = "live" | "ended" | "revoked" | "gone" | "unknown";

/**
 * A name's state in the live view. `seenExpiry` is the expiry it had when this
 * page last saw it registered, undefined if never: only a name seen live here
 * can turn "revoked". One already gone when the page opened (e.g. removed by
 * demo:reset) is just "gone".
 */
export function liveState(
  level: { status: LevelStatus; expiry: number | null } | undefined,
  seenExpiry: number | null | undefined,
  now: number,
): LiveState {
  if (!level) return "unknown";
  if (level.status === "registered") return level.expiry && !isNever(level.expiry) && level.expiry <= now ? "ended" : "live";
  if (seenExpiry === undefined) return "gone";
  // Expired names read as "available" too; a name whose last live expiry has passed ran out on its own.
  return level.status === "available" && seenExpiry && seenExpiry <= now ? "ended" : "revoked";
}

/**
 * Users the live view can show from a team's children, newest first: registered
 * ones not held by an admin address (org-setup's launch squad is the admin's),
 * plus any this page saw live before they were removed, so the view keeps
 * showing what was cut off.
 */
export function liveCandidates(
  children: Pick<ChildView, "name" | "status" | "owner">[],
  opts: { admins: (string | null | undefined)[]; seenLive: (name: string) => boolean },
): string[] {
  const admins = opts.admins.filter((a): a is Address => !!a && isAddress(a, { strict: false }));
  const heldByAdmin = (owner: Address | null) => !!owner && admins.some((a) => isAddressEqual(a, owner));
  // The relay lists children in the order their labels were first registered, so newest last.
  return children
    .filter((c) => (c.status === "registered" ? !heldByAdmin(c.owner) : opts.seenLive(c.name)))
    .map((c) => c.name)
    .reverse();
}

// --- Company setup --------------------------------------------------------------------

/**
 * Whether "Company setup" goes above the live view: when there's no company
 * yet, or the reads say it isn't set up. A read in flight or one that failed
 * (e.g. a rate-limited RPC) says nothing, so setup stays under More tools.
 */
export function companySetupFirst(
  root: string | null,
  node: { active: boolean; subregistry: Address | null; hasBundle: boolean; loading: boolean; bundleLoading: boolean; error: unknown; bundleError: unknown },
): boolean {
  if (!root) return true;
  const known = !node.loading && !node.bundleLoading && !node.error && !node.bundleError;
  const done = node.active && !!node.subregistry && node.hasBundle;
  return known && !done;
}

// --- Bundle drafts --------------------------------------------------------------------

export const providerLabel = (id: string) => PROVIDERS.find((p) => p.id === id)?.label ?? id;

/** A level above the name being edited. A null bundle allows nothing (the relay's default deny). */
export type LevelBundle = { name: string; bundle: Bundle | null };

/** What the levels above a name allow for one provider. */
export type LimitsAbove = {
  /** The nearest level above that doesn't allow the provider; null when every level does. */
  blockedBy: string | null;
  /** The tightest dollar cap above, and the level that sets it. */
  cap: { value: number; by: string } | null;
  /** The tightest count limit above (requests or images), and the level that sets it. */
  max: { value: number; by: string } | null;
};

/** `above` is root first. On equal limits the nearer level is named. */
export function limitsAbove(above: LevelBundle[], provider: ProviderId): LimitsAbove {
  const out: LimitsAbove = { blockedBy: null, cap: null, max: null };
  for (const level of above) {
    if (!level.bundle?.keys.includes(provider)) out.blockedBy = level.name;
    const cap = level.bundle?.caps[provider];
    if (cap !== undefined && (!out.cap || cap <= out.cap.value)) out.cap = { value: cap, by: level.name };
    const max = level.bundle?.maxes?.[provider];
    if (max !== undefined && (!out.max || max <= out.max.value)) out.max = { value: max, by: level.name };
  }
  return out;
}

const pickLimits = <T>(limits: Partial<Record<ProviderId, T>> | undefined, keys: ProviderId[]) =>
  Object.fromEntries(keys.filter((k) => limits?.[k] !== undefined).map((k) => [k, limits![k]])) as Partial<Record<ProviderId, T>>;

/**
 * Default bundle for a new name: what the parent allows (only providers every
 * level in `above` allows, when given), with the parent's limits, month period.
 */
export function defaultBundle(parent: Bundle | null, period: Period = "month", above?: LevelBundle[]): Bundle {
  if (!parent) return { keys: ["mock"], caps: { mock: 1 }, maxes: {}, period };
  const keys = above ? parent.keys.filter((k) => !limitsAbove(above, k).blockedBy) : [...parent.keys];
  return { keys, caps: pickLimits(parent.caps, keys), maxes: pickLimits(parent.maxes, keys), period };
}

/** Nothing ticked: the admin picks what a new member gets. */
export const emptyBundle = (period: Period = "month"): Bundle => ({ keys: [], caps: {}, maxes: {}, period });

/** Bundle form state: limits stay strings while typing ("0." must survive a keystroke). */
export type BundleDraft = {
  keys: ProviderId[];
  caps: Partial<Record<ProviderId, string>>;
  maxes: Partial<Record<ProviderId, string>>;
  period: Period;
};

const stringify = (limits: Partial<Record<ProviderId, number>> | undefined) =>
  Object.fromEntries(Object.entries(limits ?? {}).map(([k, v]) => [k, String(v)])) as Partial<Record<ProviderId, string>>;

export const draftFromBundle = (b: Bundle): BundleDraft => ({ keys: [...b.keys], caps: stringify(b.caps), maxes: stringify(b.maxes), period: b.period });

/** The bundle a draft describes, or an error to show. An empty limit = no limit at this level. */
export function bundleFromDraft(d: BundleDraft): { bundle: Bundle; error: null } | { bundle: null; error: string } {
  if (d.keys.length === 0) return { bundle: null, error: "Pick at least one API." };
  const caps: Bundle["caps"] = {};
  const maxes: NonNullable<Bundle["maxes"]> = {};
  // Catalog order, so the same choices always write the same relay.keys value.
  const keys = PROVIDER_IDS.filter((p) => d.keys.includes(p));
  for (const p of keys) {
    const rawCap = (d.caps[p] ?? "").trim().replace(/^\$/, "");
    if (rawCap && catalogEntry(p).dollarCaps) {
      const n = Number(rawCap);
      if (!Number.isFinite(n) || n < 0) return { bundle: null, error: `The ${providerLabel(p)} cap must be a dollar amount.` };
      caps[p] = n;
    }
    const rawMax = (d.maxes[p] ?? "").trim();
    if (rawMax) {
      const n = Number(rawMax);
      if (!Number.isInteger(n) || n < 0) return { bundle: null, error: `The ${providerLabel(p)} limit must be a whole number of ${countUnit(p)}.` };
      maxes[p] = n;
    }
  }
  return { bundle: { keys, caps, maxes, period: d.period }, error: null };
}

// --- Local settings -------------------------------------------------------------------

/** Plan names created from this browser, per resolver (plans can't be listed on-chain). */
export const plansStorageKey = (resolver: Address) => `keyless-relay:plans:${resolver.toLowerCase()}`;

/** SessionMinter address deployed or pasted in this browser (NEXT_PUBLIC_SESSION_MINTER wins). */
export const MINTER_STORAGE = "keyless-relay:session-minter";

/** Company name picked on this page while RELAY_ROOT_NAME is unset. */
export const DRAFT_ROOT_STORAGE = "keyless-relay:draft-root";

/** What to put in .env.local (variable names from lib/relay/config.ts). */
export const envTemplate = (root: string) =>
  [
    `RELAY_ROOT_NAME=${root}`,
    "OPENAI_API_KEY=sk-...",
    "# A small hot wallet with Sepolia ETH; it tops up new members",
    "FUNDER_PRIVATE_KEY=0x...",
    "FUNDER_AMOUNT_ETH=0.01",
  ].join("\n");

// --- DNS alias ----------------------------------------------------------------------

/** The relay's own alias setting (parsed by lib/relay/config.ts as "from=to"). */
export const dnsAliasEnvLine = (domain: string, root: string) => `RELAY_DNS_ALIAS=${domain}=${root}`;

export const DNS_ALIAS_RESOLVER: Address = addresses.DNSAliasResolver;

/**
 * The ENS1 TXT record that makes a DNS domain resolve as the ENS root
 * (DNSAliasResolver suffix replacement). Shared leading labels are kept, so
 * acme.com + acme.eth gives "com eth" and x.acme.com resolves as x.acme.eth.
 */
export function dnsAliasRecord(domain: string, root: string) {
  const d = domain.split(".");
  const r = root.split(".");
  let k = 0;
  while (k < Math.min(d.length, r.length) - 1 && d[k] === r[k]) k++;
  const from = d.slice(k).join(".");
  const to = r.slice(k).join(".");
  return { txt: `ENS1 ${DNS_ALIAS_RESOLVER} ${from} ${to}`, from, to };
}
