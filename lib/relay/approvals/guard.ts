// The approvals store as the relay's guard (lib/relay/guard.ts): suspensions
// pause a name and everything below it, overlays narrow it to an approved
// scope, observe() runs drift detection, and a broken store fails closed.

import type { Address } from "viem";

import type { GuardLevel, Overlay, Pause, RelayGuard } from "../guard";
import type { Meter } from "../meter";
import { type RulesCtx, keyOf, observeLevels } from "./incidents";
import type { ApprovalsStore } from "./store";

export type GuardDeps = RulesCtx & { store: ApprovalsStore; meter: () => Meter | null; root: () => string | null; rootOwner: () => Address | null };

export function approvalsGuard(deps: GuardDeps): RelayGuard {
  const { store } = deps;
  const keys = (levels: GuardLevel[]) => levels.filter((l) => l.status === "registered" && l.resource).map((l) => ({ level: l, key: keyOf(l.name, l.resource) }));
  return {
    paused(levels: GuardLevel[]): Pause | null {
      for (const { level, key } of keys(levels)) {
        const s = store.data.suspensions[key];
        if (s) return { incidentId: s.incidentId, name: level.name, reason: s.permanent ? "revoked" : "under review" };
      }
      return null;
    },
    overlays(levels: GuardLevel[]): Overlay[] {
      const out: Overlay[] = [];
      const all = Object.values(store.data.overlays);
      if (!all.length) return out;
      for (const { level, key } of keys(levels)) {
        for (const o of all) {
          if (o.key !== key) continue;
          out.push({ id: o.id, after: level.name, name: level.name, bundle: o.bundle, chain: o.chain, notAfter: o.notAfter, bucket: o.bucket });
        }
      }
      return out;
    },
    observe(levels: GuardLevel[], nowSec: number) {
      const root = deps.root();
      if (!root) return;
      try {
        observeLevels(store, deps.meter(), { root, rootOwner: deps.rootOwner(), knownRecipients: deps.knownRecipients }, levels, nowSec);
      } catch {}
    },
    unavailable: () => store.unavailable(),
  };
}
