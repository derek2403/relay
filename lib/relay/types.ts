// JSON shapes of the relay's HTTP API, shared by the server routes and the admin app.
// Bigints are serialized as decimal strings.

import type { Address } from "viem";

import type { Bundle, ProviderId } from "./bundle";

export type LevelStatus = "registered" | "reserved" | "available" | "missing";

/** One level of the chain from the company root down to a name. */
export type LevelView = {
  /** Full name at this level, e.g. "eng.acme.eth". */
  name: string;
  /** Registry holding this level's label. */
  registry: Address | null;
  /** Resolver set on this level's entry: where its bundle lives (the parent's resolver, by design). */
  resolver: Address | null;
  /** This level's own subname registry, if any. */
  subregistry: Address | null;
  status: LevelStatus;
  owner: Address | null;
  /** Unix seconds. */
  expiry: number | null;
  /** EAC resource of the entry (decimal); changes when the label is re-registered. */
  resource: string | null;
  bundle: Bundle | null;
  /**
   * Tokens for this name issued before this time (unix seconds) are refused:
   * the `relay.nbf` text record, written by the level above. Null when unset.
   */
  nbf?: number | null;
  /**
   * The `relay.chain` record (blockchain grant, written by the level above) as raw text,
   * trimmed; null when unset, unreadable or longer than 4096 characters. Parse with lib/chain/grant.
   */
  chain?: string | null;
  /** Dollars spent (settled) in the current period, per provider. */
  spent: Partial<Record<ProviderId, number>>;
  /**
   * Dollars held right now by calls still running (their worst case), per provider; only providers with
   * a hold are listed. Budget checks count spent + reserved; displays can show them apart.
   */
  reserved?: Partial<Record<ProviderId, number>>;
  /** Count used in the current period per provider (requests, or images for image APIs). */
  used?: Partial<Record<ProviderId, number>>;
  checks: {
    /** Registry is a genuine ENSv2 UserRegistry proxy (null when not applicable, e.g. ETHRegistry). */
    registryVerified: boolean | null;
    /** Resolver is a genuine PermissionedResolver proxy. */
    resolverVerified: boolean | null;
    /** The registry's parent pointer matches the path used (no aliasing). */
    canonical: boolean | null;
  };
};

/**
 * GET /api/relay/policy?name=&provider= — what the relay would decide right now (read-only).
 * Needs the admin (RELAY_ADMIN_TOKEN, as a Bearer header or the cookie set at
 * /api/relay/admin) or an agent token for the name or one above it; open to
 * anyone only in development without RELAY_ADMIN_TOKEN.
 */
export type PolicyResponse = {
  name: string;
  provider: ProviderId | null;
  root: string;
  allowed: boolean;
  /** Why it would be refused, or null. */
  reason: string | null;
  /** Smallest remaining dollar budget across capped levels, or null if uncapped. */
  remaining: number | null;
  levels: LevelView[];
};

/** GET /api/relay/status */
export type StatusResponse = {
  /** RELAY_ROOT_NAME, e.g. "acme.eth"; null when unset. */
  root: string | null;
  providers: { id: ProviderId; label: string; configured: boolean; metered: boolean }[];
  recordPrefix: string;
  dnsAlias: { from: string; to: string } | null;
  requireCanonical: boolean;
  /** Relay base URL tools should use, e.g. "http://localhost:3000/api/relay". */
  baseUrl: string;
  /** Who may read /log and /policy: "token" (admin or agent tokens), "open" (anyone, development) or "closed" (agents only). */
  viewAuth?: "token" | "open" | "closed";
  /** RELAY_ROOT_OWNER, the only address accepted as the root's owner; null when not pinned. */
  rootOwner?: string | null;
  /** Something to fix about the root (not pinned, held by someone else, expiring soon), or null. */
  rootWarning?: string | null;
  /** Longest token lifetime the relay accepts, in seconds. */
  maxTokenTtlSec?: number;
  /** Set when spend can't be read or saved; metered calls are refused until it's fixed. */
  meterError?: string | null;
  /** Requests refused before the caller proved it owns a name (counted, not logged), since the relay started. */
  rejectedRequests?: number;
  /** Names paused while an approver reviews an incident. Absent from relays without approvals. */
  paused?: { name: string; incidentId: string }[];
  /** World ID (approver verification) setup. Absent from relays without approvals. */
  world?: { configured: boolean; environment: string; problems: string[] };
};

/** GET /api/relay/log — newest first. Same access rules as /policy; an agent token sees only its own names. */
export type LogEntry = {
  ts: number;
  name: string | null;
  provider: string;
  method: string;
  path: string;
  allowed: boolean;
  reason: string | null;
  /** Upstream HTTP status, when the call was forwarded. */
  status: number | null;
  costUsd: number | null;
  /** True when cost was estimated (e.g. stream aborted before usage arrived). */
  estimated: boolean;
  signer: Address | null;
};

/** GET /api/ens/children?name= — names registered directly under a name. */
export type ChildrenResponse = {
  name: string;
  /** The name's subname registry, or null if it has none. */
  registry: Address | null;
  children: ChildView[];
};

export type ChildView = {
  label: string;
  name: string;
  status: LevelStatus;
  owner: Address | null;
  expiry: number | null;
  resolver: Address | null;
  subregistry: Address | null;
  bundle: Bundle | null;
  /** The `relay.chain` record text (see LevelView.chain). */
  chain?: string | null;
};

/** Error body for every relay/API failure. */
export type RelayError = { error: string; reason?: string };

/** GET /api/ens/owned?address= — names under the company root currently owned by an address (deepest first). */
export type OwnedResponse = {
  address: Address;
  names: {
    name: string;
    depth: number;
    expiry: number | null;
    hasSubregistry: boolean;
    /** Every level above it is held by the company owner (the company added it). Absent from older relays. */
    member?: boolean;
  }[];
};

/**
 * POST /api/fund { name } — tops up a member's wallet with a little Sepolia ETH
 * from the relay's funder wallet, after checking on-chain that the name is under
 * the company root, registered, and owned by the address being funded.
 */
export type FundResponse =
  | { funded: true; address: Address; amountEth: string; txHash: string }
  | { funded: false; address: Address | null; reason: string };
