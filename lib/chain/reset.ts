// The chain half of the admin round reset (POST /api/relay/admin/reset with
// {"chain": true}, used by `npm run demo:reset`): so the next demo round starts
// clean without deleting anything.
//
//  - Archives (sets `archivedAt`, never deletes) every settled proposal, every
//    task run, every resolved incident, and the open items and escrows of names
//    that no longer exist. An open proposal or incident of a removed name is
//    first moved to `expired`. List endpoints leave archived items out unless
//    asked (`?archived=1`); the records stay for the audit trail.
//  - Resets the allowance ledger: every bucket's spent goes back to 0 and its
//    reserved to what in-flight payments still hold. A reservation that is
//    still "reserved" for a proposal in submitting / submitted / included /
//    uncertain (or approved: a submit may be preparing it) is never touched,
//    so the tracker can still commit or release it.
//  - Lifts suspensions and approved-scope overlays of names that no longer
//    exist (or were re-registered: a new resource is a new key).
//
// Names are read from ENS first; a name that can't be read is left alone
// (reported in `skipped`). Each store then changes in one synchronous commit.

import { isChainReadError, type ChainReader } from "../relay/ens";
import type { ApprovalsStore } from "../relay/approvals/store";
import type { LedgerData } from "./ledger";
import { PENDING, type Proposal, TERMINAL, transition } from "./proposals";
import type { ChainStore } from "./store";

export type ChainResetResult = {
  archived: { proposals: number; runs: number; incidents: number; escrows: number };
  /** Open items of removed names moved to `expired` (and archived). */
  expired: { proposals: string[]; incidents: string[] };
  /** In-flight proposals of removed names left visible until they settle (archived by a later reset). */
  inFlight: string[];
  ledger: {
    /** Buckets whose spent or reserved changed. */
    reset: number;
    /** Reservations still held for in-flight payments (untouched). */
    held: string[];
    /** Stale "reserved" reservations released (their proposal is settled or never got signed). */
    released: string[];
  };
  lifted: { suspensions: string[]; overlays: string[] };
  skipped: { name: string; reason: string }[];
};

type Status = "gone" | "live" | "unknown";

/** `<namehash>:<resource>` → the resource. */
const resourceOfKey = (key: string) => key.slice(key.lastIndexOf(":") + 1);

/** States whose held allowance may still be signed or mined: never released by a reset. */
const HOLDS: readonly Proposal["state"][] = [...PENDING, "approved"];

/**
 * Reads whether each name still exists: "gone" when it isn't registered (or,
 * with a resource, was re-registered under another one), "unknown" when ENS
 * can't be read or the name isn't under the root.
 */
export function nameChecker(reader: ChainReader, root: string | null, skipped: ChainResetResult["skipped"]) {
  const levels = new Map<string, Promise<{ registered: boolean; resource: string } | null>>();
  const read = (name: string) => {
    let p = levels.get(name);
    if (!p) {
      p = (async () => {
        if (!root || (name !== root && !name.endsWith(`.${root}`))) {
          skipped.push({ name, reason: root ? `not under ${root}` : "the relay has no root name" });
          return null;
        }
        try {
          const all = await reader.readLevels(root, name);
          const leaf = all[all.length - 1];
          return { registered: leaf?.status === "registered", resource: leaf?.resource ?? "0" };
        } catch (err) {
          skipped.push({ name, reason: isChainReadError(err) ? err.message : "could not read ENS" });
          return null;
        }
      })();
      levels.set(name, p);
    }
    return p;
  };
  return async (name: string, resource: string | null = null): Promise<Status> => {
    const leaf = await read(name);
    if (!leaf) return "unknown";
    if (!leaf.registered) return "gone";
    return resource !== null && resource !== leaf.resource ? "gone" : "live";
  };
}

export type ChainResetDeps = {
  chain: ChainStore;
  approvals: ApprovalsStore;
  reader: ChainReader;
  root: string | null;
  nowSec?: number;
};

const nameKey = (name: string, resource: string | null) => `${name}\u0000${resource ?? ""}`;

export async function resetChainRound(deps: ChainResetDeps): Promise<ChainResetResult> {
  const { chain, approvals } = deps;
  const now = deps.nowSec ?? Math.floor(Date.now() / 1000);
  const result: ChainResetResult = {
    archived: { proposals: 0, runs: 0, incidents: 0, escrows: 0 },
    expired: { proposals: [], incidents: [] },
    inFlight: [],
    ledger: { reset: 0, held: [], released: [] },
    lifted: { suspensions: [], overlays: [] },
    skipped: [],
  };
  const down = chain.unavailable() ?? approvals.unavailable();
  if (down) throw new Error(down);

  // 1. Which names still exist: only for items a settled state doesn't already decide.
  const snap = chain.snapshot();
  const ad = approvals.data;
  const wanted = new Map<string, { name: string; resource: string | null }>();
  const want = (name: string, resource: string | null) => wanted.set(nameKey(name, resource), { name, resource });
  for (const p of Object.values(snap.proposals)) if (!p.archivedAt && !TERMINAL.includes(p.state)) want(p.agent.name, p.agent.resource);
  for (const e of snap.escrows) if (!e.archivedAt) want(e.deployedBy, null);
  for (const i of Object.values(ad.incidents)) if (!i.archivedAt && i.state === "open") want(i.subject.name, i.subject.resource);
  for (const [key, s] of Object.entries(ad.suspensions)) want(s.name, resourceOfKey(key));
  for (const o of Object.values(ad.overlays)) want(o.name, resourceOfKey(o.key));

  const check = nameChecker(deps.reader, deps.root, result.skipped);
  const status = new Map<string, Status>();
  for (const [k, { name, resource }] of wanted) status.set(k, await check(name, resource));
  const gone = (name: string, resource: string | null) => status.get(nameKey(name, resource)) === "gone";

  // 2. The chain store, in one write.
  chain.update((d) => {
    for (const [id, p0] of Object.entries(d.proposals)) {
      if (p0.archivedAt) continue;
      let p = p0;
      if (PENDING.includes(p.state)) {
        // Signed and maybe mined: stays visible (and tracked) until it settles.
        if (gone(p.agent.name, p.agent.resource)) result.inFlight.push(id);
        continue;
      }
      if (!TERMINAL.includes(p.state)) {
        if (!gone(p.agent.name, p.agent.resource)) continue;
        p = transition(p, "expired", "the agent's name was removed (admin round reset)", now);
        result.expired.proposals.push(id);
      }
      d.proposals[id] = { ...p, archivedAt: now };
      result.archived.proposals++;
    }
    for (const [name, runs] of Object.entries(d.runs)) {
      d.runs[name] = runs.map((r) => {
        if (r.archivedAt) return r;
        result.archived.runs++;
        return { ...r, archivedAt: now };
      });
    }
    d.escrows = d.escrows.map((e) => {
      if (e.archivedAt || !gone(e.deployedBy, null)) return e;
      result.archived.escrows++;
      return { ...e, archivedAt: now };
    });
    const ledger = resetLedger(d.ledger, d.proposals);
    d.ledger = ledger.data;
    result.ledger = { reset: ledger.reset, held: ledger.held, released: ledger.released };
  });

  // 3. The approvals store, in one commit.
  approvals.commit((d) => {
    for (const [id, i] of Object.entries(d.incidents)) {
      if (i.archivedAt) continue;
      if (i.state === "open") {
        if (!gone(i.subject.name, i.subject.resource)) continue;
        i.state = "expired";
        i.revision += 1;
        i.events.push({ at: now, kind: "reset", by: "admin", detail: "the subject's name was removed (admin round reset)" });
        result.expired.incidents.push(id);
      }
      i.archivedAt = now;
      result.archived.incidents++;
    }
    for (const [key, s] of Object.entries(d.suspensions)) {
      if (!gone(s.name, resourceOfKey(key))) continue;
      delete d.suspensions[key];
      result.lifted.suspensions.push(s.name);
    }
    for (const [id, o] of Object.entries(d.overlays)) {
      if (!gone(o.name, resourceOfKey(o.key))) continue;
      delete d.overlays[id];
      result.lifted.overlays.push(`${o.name} (${id})`);
    }
    const a = result.archived;
    d.audit.push({
      at: now,
      kind: "round-reset",
      by: "admin",
      subject: null,
      detail:
        `archived ${a.proposals} proposals, ${a.runs} task runs, ${a.incidents} incidents, ${a.escrows} escrows; ` +
        `lifted ${result.lifted.suspensions.length} suspensions and ${result.lifted.overlays.length} overlays of removed names; ` +
        `reset ${result.ledger.reset} allowance buckets (${result.ledger.held.length} in-flight reservations kept)`,
    });
  });
  return result;
}

/**
 * The ledger after a round reset: spent 0 everywhere, reserved = what held
 * reservations still hold. A "reserved" reservation is held when its proposal
 * may still be signed or mined (HOLDS), or when no proposal can be matched to
 * it; any other "reserved" one is released. Committed and released
 * reservations stay as they are (idempotent commit/release keep working).
 */
export function resetLedger(ledger: LedgerData, proposals: Record<string, Proposal>): { data: LedgerData; reset: number; held: string[]; released: string[] } {
  const byReservation = new Map<string, Proposal>();
  for (const p of Object.values(proposals)) if (p.reservationId) byReservation.set(p.reservationId, p);
  // A submit reserves before the proposal records the id (rsv_<proposal id>_<random>).
  const owner = (id: string): Proposal | null => {
    const hit = byReservation.get(id);
    if (hit) return hit;
    const m = id.match(/^rsv_(prp_[0-9a-f]+)_/);
    return m && Object.hasOwn(proposals, m[1]) ? proposals[m[1]] : null;
  };

  const held: string[] = [];
  const released: string[] = [];
  const reservations = { ...ledger.reservations };
  const holding = new Map<string, bigint>();
  for (const [id, r] of Object.entries(ledger.reservations)) {
    if (r.state !== "reserved") continue;
    const p = owner(id);
    if (!p || HOLDS.includes(p.state)) {
      held.push(id);
      for (const key of r.keys) holding.set(key, (holding.get(key) ?? 0n) + BigInt(r.amount));
    } else {
      released.push(id);
      reservations[id] = { ...r, state: "released" };
    }
  }

  let reset = 0;
  const buckets: LedgerData["buckets"] = {};
  const keys = new Set([...Object.keys(ledger.buckets), ...holding.keys()]);
  for (const key of keys) {
    const before = ledger.buckets[key] ?? { spent: "0", reserved: "0" };
    const after = { spent: "0", reserved: (holding.get(key) ?? 0n).toString() };
    if (before.spent !== after.spent || before.reserved !== after.reserved) reset++;
    if (after.reserved !== "0") buckets[key] = after;
  }
  return { data: { buckets, reservations }, reset, held, released };
}
