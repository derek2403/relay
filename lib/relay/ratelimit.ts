// Token-bucket rate limits for the relay's public endpoints.
//
// Everything the relay answers can cost Sepolia RPC calls, and all of it
// shares one RPC URL. Each limit has a per-client bucket and a global one.
// Route handlers can't see the socket address, and a client can send its own
// X-Forwarded-For when no proxy overwrites it, so the header is only trusted
// when RELAY_TRUST_PROXY says a proxy in front of the relay appends to it.
// Otherwise every caller shares one client key ("direct"); on a laptop demo
// that is the same thing, since every call comes from 127.0.0.1 anyway.

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    readonly capacity: number,
    readonly refillPerSec: number,
    private readonly maxKeys = 10_000,
  ) {}

  private bucket(key: string, now: number) {
    let b = this.buckets.get(key);
    if (b) {
      b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 1000) * this.refillPerSec);
      b.at = now;
      this.buckets.delete(key); // re-insert: Map order is the LRU order
    } else {
      b = { tokens: this.capacity, at: now };
      if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value!);
    }
    this.buckets.set(key, b);
    return b;
  }

  /** True when `key` has at least one token left (nothing is taken). */
  has(key: string, now = Date.now()): boolean {
    return this.bucket(key, now).tokens >= 1;
  }

  /** Takes one token; false (and nothing taken) when the bucket is empty. */
  take(key: string, now = Date.now()): boolean {
    const b = this.bucket(key, now);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Takes one token even when that leaves the bucket in debt (to record a failure after the fact). */
  spend(key: string, now = Date.now()) {
    const b = this.bucket(key, now);
    b.tokens = Math.max(-this.capacity, b.tokens - 1);
  }
}

/** A per-client limit plus a global one. */
export class ClientLimit {
  readonly perClient: RateLimiter;
  readonly global: RateLimiter;

  constructor(perClient: [capacity: number, perSec: number], global: [capacity: number, perSec: number]) {
    this.perClient = new RateLimiter(...perClient);
    this.global = new RateLimiter(...global);
  }

  has(client: string) {
    return this.perClient.has(client) && this.global.has("*");
  }

  take(client: string) {
    if (!this.has(client)) return false;
    this.perClient.take(client);
    this.global.take("*");
    return true;
  }

  spend(client: string) {
    this.perClient.spend(client);
    this.global.spend("*");
  }
}

/** The key every caller shares when no trusted proxy names the client. */
export const DIRECT_CLIENT = "direct";

/**
 * How many proxies in front of the relay append to X-Forwarded-For
 * (RELAY_TRUST_PROXY: a number, or "true" for one). 0 = don't trust the header.
 */
export function trustedProxyHops(env: Record<string, string | undefined> = process.env): number {
  const raw = env.RELAY_TRUST_PROXY?.trim().toLowerCase() ?? "";
  if (!raw || raw === "false" || raw === "0" || raw === "no") return 0;
  if (raw === "true" || raw === "yes") return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 10) : 0;
}

/**
 * The client's address as the nearest trusted proxy saw it: with N trusted
 * proxies, the N-th X-Forwarded-For entry from the right (entries further left
 * are whatever the client sent). Without RELAY_TRUST_PROXY, DIRECT_CLIENT.
 */
export function clientKey(headers: Headers, hops = trustedProxyHops()): string {
  if (hops <= 0) return DIRECT_CLIENT;
  const hopsSeen = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (hopsSeen.length) return hopsSeen[Math.max(0, hopsSeen.length - hops)];
  return headers.get("x-real-ip")?.trim() || "unknown";
}

export type RelayLimits = {
  /** Relay calls that fail before the caller proves it owns a name (bad tokens, forged owners, unknown names). */
  failures: ClientLimit;
  /** /api/relay/policy reads. */
  policy: ClientLimit;
  /** /api/ens/children reads (log scans). */
  children: ClientLimit;
  /** /api/ens/owned reads (a walk of the company tree, cached for a few seconds). */
  owned: ClientLimit;
  /** POST /api/fund requests, per client: each costs the chain reads that decide eligibility. */
  fundChecks: ClientLimit;
  /** POST /api/fund grants, per owner address: only requests that passed every check take a token. */
  fund: ClientLimit;
  /** (name, signer) pairs that recently passed the owner check; they skip the failure limit. */
  knownGood: Map<string, number>;
};

const KNOWN_GOOD_TTL_MS = 10 * 60_000;
const MAX_KNOWN_GOOD = 10_000;

export function createLimits(): RelayLimits {
  return {
    failures: new ClientLimit([30, 0.5], [300, 5]),
    policy: new ClientLimit([60, 2], [600, 20]),
    children: new ClientLimit([60, 2], [240, 8]),
    // One walk serves every caller for a few seconds, so reads are cheap; the global bucket is generous.
    owned: new ClientLimit([20, 0.5], [600, 10]),
    fundChecks: new ClientLimit([10, 0.1], [300, 5]),
    fund: new ClientLimit([2, 0.01], [60, 0.5]),
    knownGood: new Map(),
  };
}

export function isKnownGood(limits: RelayLimits, pair: string): boolean {
  const until = limits.knownGood.get(pair);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  limits.knownGood.delete(pair);
  return false;
}

export function markKnownGood(limits: RelayLimits, pair: string) {
  limits.knownGood.delete(pair);
  if (limits.knownGood.size >= MAX_KNOWN_GOOD) limits.knownGood.delete(limits.knownGood.keys().next().value!);
  limits.knownGood.set(pair, Date.now() + KNOWN_GOOD_TTL_MS);
}

// Kept on globalThis so dev-server reloads keep the buckets.
const g = globalThis as unknown as { __relayLimits?: RelayLimits };

export function relayLimits(): RelayLimits {
  g.__relayLimits ??= createLimits();
  return g.__relayLimits;
}
