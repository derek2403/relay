// Relay-side suspensions and approved scopes, applied on every decide().
//
// ENS says what a name may do; the guard can only take away from that: pause a
// name and everything below it while a human reviews an incident, or narrow it
// to a scope an approver signed off on (an overlay: an extra virtual level
// right after the subject). The approvals module implements RelayGuard and
// registers a factory for it at load; relayDeps() then hands it to decide().
//
// State lives on globalThis: Next can load this module more than once (the
// instrumentation bundle and each route bundle, or after a dev-server reload),
// and every copy must see the guard the approvals module registered.

import { type Address, isAddressEqual } from "viem";

import type { Bundle } from "./bundle";
import type { LevelView } from "./types";

export type GuardLevel = Pick<LevelView, "name" | "resource" | "owner" | "expiry" | "bundle" | "chain" | "status">;

/** A suspension: calls by `name` and every name below it are refused until an approver resolves the incident. */
export type Pause = { incidentId: string; name: string; reason: string };

/**
 * A relay-side approved scope: an extra virtual level placed right after the
 * level named `after`. Its `bundle` narrows provider access (null = it doesn't
 * narrow providers, only `chain`); its spend is metered in its own `bucket`
 * (e.g. "approval:<id>") instead of a calendar period.
 */
export type Overlay = {
  id: string;
  after: string;
  name: string;
  bundle: Bundle | null;
  /** `relay.chain` record text for the approved blockchain scope; null = the approved scope has no blockchain access. */
  chain: string | null;
  /** Unix seconds; at or after this the overlay denies (the approved scope ended). */
  notAfter: number;
  bucket: string;
};

export interface RelayGuard {
  /** Any suspension covering these levels (root first), checked on every relay decision; null = none. */
  paused(levels: GuardLevel[], nowSec: number): Pause | null;
  /** Overlays for these levels (usually 0 or 1). Expired overlays are returned too (the caller denies). */
  overlays(levels: GuardLevel[], nowSec: number): Overlay[];
  /** Called once per decide() with the fresh chain view (drift detection hook). May open incidents. Never throws. */
  observe?(levels: GuardLevel[], nowSec: number): void;
  /** Fail-closed signal: non-null = the guard's store is broken; decide() denies names below the member level. */
  unavailable?(): string | null;
}

type GuardState = { guard: RelayGuard | null; factory: (() => RelayGuard) | null };
const g = globalThis as unknown as { __relayGuard?: GuardState };
const state = (): GuardState => (g.__relayGuard ??= { guard: null, factory: null });

/** Sets (or with null, clears) the guard directly. Mostly for tests; the server registers a factory. */
export const setRelayGuard = (guard: RelayGuard | null) => {
  state().guard = guard;
};

/**
 * Registers how to build the server's guard (the approvals module calls this
 * at load). The guard is built on first use; registering again (a reloaded
 * module) replaces the factory and drops the old instance.
 */
export function registerGuardFactory(factory: (() => RelayGuard) | null) {
  const s = state();
  s.factory = factory;
  s.guard = null;
}

/** The guard for this process: the one set directly, else one built from the registered factory, else null. */
export function relayGuard(): RelayGuard | null {
  const s = state();
  if (!s.guard && s.factory) {
    try {
      s.guard = s.factory();
    } catch (err) {
      // A guard that can't start must not mean "no suspensions": fail closed until it can.
      const why = `the approvals guard could not start (${err instanceof Error ? err.message : String(err)})`;
      return brokenGuard(why);
    }
  }
  return s.guard;
}

/** A guard that pauses nothing and reports itself unavailable, so decide() fails closed. */
export const brokenGuard = (why: string): RelayGuard => ({
  paused: () => null,
  overlays: () => [],
  unavailable: () => why,
});

/**
 * Index of the member level: the first level from the root whose owner
 * differs from the company owner (`rootOwner`, else the root's own owner).
 * Levels above it are the company's, the member level is the human, and
 * everything below it is an agent. -1 when every level is the company's.
 */
export function memberLevelIndex(levels: Pick<GuardLevel, "owner">[], rootOwner: Address | null): number {
  const company = rootOwner ?? levels[0]?.owner ?? null;
  if (!company) return levels.length ? 0 : -1;
  return levels.findIndex((l) => !(l.owner && isAddressEqual(l.owner, company)));
}
