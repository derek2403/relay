// The relay's decision for one call: may `name` use `provider` right now?
//
// Reads every level from RELAY_ROOT_NAME down to the name (fresh from the
// chain), requires each to be registered and genuine, checks the caller owns
// the leaf and the root is still held by RELAY_ROOT_OWNER, then applies
// evaluate() from bundle.ts with each level's spend and count (settled plus
// reserved) in its own period.

import { type Address, isAddressEqual } from "viem";

import { namehash, tryNormalize } from "../ens/names";
import { PROVIDER_IDS, type ProviderId, evaluate, isProviderId, periodKey } from "./bundle";
import { countText } from "./catalog";
import { type RelayConfig, applyDnsAlias, getConfig } from "./config";
import { type ChainLevel, type ChainReader, getChainReader, isChainReadError } from "./ens";
import { type Meter, getMeter, spendKey } from "./meter";
import type { LevelView, PolicyResponse } from "./types";

export type PolicyDeps = { config: RelayConfig; reader: ChainReader; meter: Meter; now?: () => Date };

/** Why a call was refused, so the relay can pick the HTTP status. */
export type Denial =
  | "invalid-name"
  | "no-root"
  | "outside-root"
  | "unknown-provider"
  | "not-registered"
  | "not-owner"
  | "unverified"
  | "not-canonical"
  | "root-mismatch"
  | "policy";

export type PolicyDecision = PolicyResponse & {
  denial: Denial | null;
  /** Smallest remaining count (requests or images) across count-capped levels, or null if none caps it. */
  remainingCount: number | null;
};

/** The refusal for a name whose chain has a level that is no longer registered. */
export const REVOKED_ERROR = "access revoked";
export const revokedReason = (levelName: string) => `access revoked: ${levelName} was removed or expired. Run ./relay login.`;

/** Default dependencies for the running server. */
export function relayDeps(): PolicyDeps {
  const config = getConfig();
  return { config, reader: getChainReader(config.rpcUrl), meter: getMeter(config.dataDir) };
}

type SpendLevel = Pick<LevelView, "name" | "resource" | "bundle">;

const round9 = (usd: number) => Math.round(usd * 1e9) / 1e9;

const levelSpendKey = (level: SpendLevel, provider: string, now: Date) =>
  spendKey(namehash(level.name), level.resource, provider, periodKey(level.bundle?.period ?? "month", now));

/**
 * A level with its spend and counts. `spent` is settled dollars and `reserved`
 * what calls in flight hold (their worst case, released when they settle), so a
 * live view doesn't jump up and back down on every call. Counts include calls
 * in flight.
 */
function withSpend(level: ChainLevel, meter: Meter, now: Date): LevelView {
  const spent: LevelView["spent"] = {};
  const reserved: NonNullable<LevelView["reserved"]> = {};
  const used: NonNullable<LevelView["used"]> = {};
  for (const p of PROVIDER_IDS) {
    const key = levelSpendKey(level, p, now);
    const usd = meter.spent(key);
    const held = meter.pending(key);
    if (usd > 0 || held > 0 || level.bundle?.keys.includes(p)) spent[p] = round9(usd);
    if (held > 0) reserved[p] = round9(held);
    const count = meter.used(key) + meter.pendingCount(key);
    if (count > 0 || level.bundle?.keys.includes(p)) used[p] = count;
  }
  return { ...level, spent, reserved, used };
}

const STATUS_REASON: Record<Exclude<LevelView["status"], "registered">, string> = {
  available: "is not registered (expired or removed)",
  reserved: "is reserved, not registered",
  missing: "can't be reached from the root (a parent was removed or has no subname registry)",
};

/**
 * The first level that isn't registered, or null. A removed name reads as
 * "available" (unregister sets its expiry to now) and everything below it as
 * "missing" (its registry is no longer reachable), so this names the level
 * that was actually removed or expired.
 */
export const firstDeadLevel = (levels: Pick<LevelView, "name" | "status">[]) => levels.find((l) => l.status !== "registered") ?? null;

/** The first thing wrong with the chain of levels, independent of the provider. */
function chainProblem(levels: LevelView[], signer: Address | null | undefined, config: RelayConfig): { denial: Denial; reason: string } | null {
  const dead = firstDeadLevel(levels);
  if (dead) return { denial: "not-registered", reason: revokedReason(dead.name) };
  const root = levels[0];
  if (config.rootOwner && !(root.owner && isAddressEqual(root.owner, config.rootOwner))) {
    return {
      denial: "root-mismatch",
      reason: `${root.name} is held by ${root.owner ?? "nobody"}, not ${config.rootOwner} (RELAY_ROOT_OWNER); the relay refuses every call until they match`,
    };
  }
  const leaf = levels[levels.length - 1];
  if (signer && !(leaf.owner && isAddressEqual(leaf.owner, signer))) {
    return { denial: "not-owner", reason: `${signer} does not own ${leaf.name}` };
  }
  for (const level of levels) {
    const parent = level.name.slice(level.name.indexOf(".") + 1);
    if (level.checks.registryVerified === false) {
      return { denial: "unverified", reason: `the registry holding ${level.name} is not a genuine ENSv2 UserRegistry` };
    }
    if (level.checks.resolverVerified === false) {
      return { denial: "unverified", reason: `the resolver for ${level.name} is not a genuine ENSv2 PermissionedResolver` };
    }
    if (config.requireCanonical && level.checks.canonical === false) {
      return { denial: "not-canonical", reason: `the registry holding ${level.name} doesn't point back to ${parent} (not canonical)` };
    }
  }
  return null;
}

/**
 * Decides whether `name` may use `provider`. With `signer`, the leaf's owner
 * must be that address (agent tokens); without it (the policy endpoint) no
 * owner check is made. Throws ChainReadError when the chain can't be read.
 *
 * Chain problems (unregistered level, wrong owner, fake registry or resolver,
 * root no longer held by RELAY_ROOT_OWNER) are reported before a missing or
 * unknown provider, so `decide({ name, provider: null, signer })` checks
 * ownership alone: it ends in "unknown-provider" when the chain is fine.
 */
export async function decide(
  input: { name: string; provider: string | null; signer?: Address | null },
  deps: PolicyDeps,
): Promise<PolicyDecision> {
  const { config, reader, meter } = deps;
  const now = deps.now?.() ?? new Date();
  const provider: ProviderId | null = input.provider && isProviderId(input.provider) ? input.provider : null;
  const root = config.rootName ?? "";

  const normalized = tryNormalize(input.name);
  const name = normalized ? applyDnsAlias(normalized, config.dnsAlias) : input.name;
  const base = { name, provider, root, remaining: null, remainingCount: null, levels: [] as LevelView[] };
  const deny = (denial: Denial, reason: string, levels: LevelView[] = []): PolicyDecision => ({
    ...base,
    levels,
    allowed: false,
    reason,
    denial,
  });

  if (!normalized) return deny("invalid-name", `"${input.name}" is not a valid ENS name`);
  if (config.rootError) return deny("no-root", config.rootError);
  if (!config.rootName) return deny("no-root", "The relay has no root name (set RELAY_ROOT_NAME)");
  if (name !== root && !name.endsWith(`.${root}`)) return deny("outside-root", `${name} is not under ${root}`);

  const chain = await reader.readLevels(root, name);
  const levels = chain.map((level) => withSpend(level, meter, now));

  const problem = chainProblem(levels, input.signer, config);
  if (problem) return deny(problem.denial, problem.reason, levels);

  if (!provider) {
    return deny("unknown-provider", input.provider ? `unknown provider "${input.provider}"` : "no provider given", levels);
  }

  // Budgets count what calls still running have reserved.
  const withHolds = (l: LevelView) => {
    const all: LevelView["spent"] = { ...l.spent };
    for (const [p, held] of Object.entries(l.reserved ?? {}) as [ProviderId, number][]) all[p] = round9((all[p] ?? 0) + held);
    return all;
  };
  const decision = evaluate(
    levels.map((l) => ({ name: l.name, bundle: l.bundle, spent: withHolds(l), used: l.used })),
    provider,
  );
  return {
    ...base,
    levels,
    allowed: decision.allowed,
    reason: decision.reason,
    remaining: decision.remaining,
    remainingCount: decision.remainingCount ?? null,
    denial: decision.allowed ? null : "policy",
  };
}

/** Adds `usd` (and `count`) to every level's meter for `provider`, each in its own period. */
export function charge(levels: SpendLevel[], provider: ProviderId, usd: number, meter: Meter, now = new Date(), count = 0) {
  for (const level of levels) {
    const key = levelSpendKey(level, provider, now);
    if (usd > 0) meter.add(key, usd);
    if (count > 0) meter.addCount(key, count);
    if (usd > 0 || count > 0) meter.remember(namehash(level.name), level.name);
  }
}

/** Smallest budget left (cap - settled - reserved) across the levels that cap `provider`; null when none does. */
export function available(levels: SpendLevel[], provider: ProviderId, meter: Meter, now: Date): number | null {
  let left: number | null = null;
  for (const level of levels) {
    const cap = level.bundle?.caps[provider];
    if (cap === undefined) continue;
    const key = levelSpendKey(level, provider, now);
    const l = cap - meter.spent(key) - meter.pending(key);
    left = left === null ? l : Math.min(left, l);
  }
  return left;
}

export type Reservation = {
  usd: number;
  count: number;
  /**
   * Releases the reservation and records the real cost (and count, by default
   * the reserved count) in the periods pinned when it was made. Runs once.
   */
  settle: (actualUsd: number, actualCount?: number) => void;
};

/**
 * Reserves `usd` and `count` (requests or images) for one call on every level,
 * checking every dollar cap and count cap first. Runs synchronously (no await
 * between check and hold), so two concurrent calls can never both take the
 * last of a budget or a count. The period is fixed here, so a call that
 * crosses midnight or a month boundary is billed to the period it started in.
 */
export function reserve(
  levels: SpendLevel[],
  provider: ProviderId,
  usd: number,
  meter: Meter,
  now: Date,
  count = 0,
): { ok: true; reservation: Reservation } | { ok: false; reason: string } {
  for (const level of levels) {
    const key = levelSpendKey(level, provider, now);
    const cap = level.bundle?.caps[provider];
    if (cap !== undefined) {
      const left = cap - meter.spent(key) - meter.pending(key);
      if (left <= 0 || usd > left + 1e-12) {
        return {
          ok: false,
          reason:
            left <= 0
              ? `${level.name} has used its ${provider} cap ($${cap}), counting calls still running`
              : `${level.name} has $${left.toFixed(4)} of its ${provider} cap left, less than this call could cost ($${usd.toFixed(4)})`,
        };
      }
    }
    const max = level.bundle?.maxes?.[provider];
    if (max !== undefined && count > 0) {
      const left = max - meter.used(key) - meter.pendingCount(key);
      if (left <= 0 || count > left) {
        return {
          ok: false,
          reason:
            left <= 0
              ? `${level.name} has used its ${provider} limit (${countText(provider, max)}), counting calls still running`
              : `${level.name} has ${left} of its ${countText(provider, max)} left, fewer than this call asks for (${count})`,
        };
      }
    }
  }
  const keys = levels.map((level) => levelSpendKey(level, provider, now));
  for (const level of levels) meter.remember(namehash(level.name), level.name);
  const release = meter.hold(keys, usd, count);
  let settled = false;
  return {
    ok: true,
    reservation: {
      usd,
      count,
      settle: (actualUsd, actualCount = count) => {
        if (settled) return;
        settled = true;
        release();
        for (const key of keys) {
          if (actualUsd > 0) meter.add(key, actualUsd);
          if (actualCount > 0) meter.addCount(key, actualCount);
        }
      },
    },
  };
}

// --- Root health (for /api/relay/status) ---------------------------------------

const ROOT_WARN_DAYS = 30;
const ROOT_HEALTH_TTL_MS = 60_000;
const g = globalThis as unknown as { __relayRootHealth?: { key: string; at: number; warning: string | null } };

/** A warning about the root name (not pinned, held by someone else, expiring soon), cached for a minute. */
export async function rootWarning(deps: PolicyDeps): Promise<string | null> {
  const { config } = deps;
  if (!config.rootName) return null;
  const key = `${config.rootName}|${config.rootOwner ?? ""}`;
  const cached = g.__relayRootHealth;
  if (cached && cached.key === key && Date.now() - cached.at < ROOT_HEALTH_TTL_MS) return cached.warning;

  const warnings: string[] = [];
  if (!config.rootOwner) warnings.push(`RELAY_ROOT_OWNER is not set: the relay trusts whoever holds ${config.rootName}`);
  try {
    const [root] = await deps.reader.readLevels(config.rootName, config.rootName);
    if (root.status !== "registered") warnings.push(`${config.rootName} ${STATUS_REASON[root.status]}`);
    else if (config.rootOwner && !(root.owner && isAddressEqual(root.owner, config.rootOwner))) {
      warnings.push(`${config.rootName} is held by ${root.owner}, not RELAY_ROOT_OWNER ${config.rootOwner}: every call is refused`);
    }
    const days = root.expiry ? (root.expiry * 1000 - Date.now()) / 86_400_000 : Infinity;
    if (root.status === "registered" && days < ROOT_WARN_DAYS) warnings.push(`${config.rootName} expires in ${Math.max(0, Math.floor(days))} days; renew it`);
  } catch (err) {
    if (!isChainReadError(err)) throw err;
    return warnings.join("; ") || null; // not cached: try the chain again next time
  }
  const warning = warnings.join("; ") || null;
  g.__relayRootHealth = { key, at: Date.now(), warning };
  return warning;
}
