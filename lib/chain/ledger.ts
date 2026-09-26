// Aggregate chain allowances per level, with atomic reservations.
//
// Each level with an aggregate limit has its own bucket per period
// (`chain:<node>:<resource>:<token>:<periodKey>`, or `…:approval:<id>` for an
// approved-scope overlay). A payment reserves its amount at EVERY level on the
// path in one synchronous step (check all, then write all; no await in
// between), so two agents under one parent can't both spend the parent's last
// allowance, and more agents never multiply a parent's limit. `commit` moves a
// reservation into spent once the tx is confirmed; `release` drops it when the
// tx fails. Both are idempotent by reservation id.

import { type Hex } from "viem";

import { type Period, periodKey } from "../relay/bundle";

export type Bucket = { spent: string; reserved: string };
export type Reservation = {
  amount: string;
  keys: string[];
  state: "reserved" | "committed" | "released";
  at: number;
  /** Level names, root first, for display. */
  names: string[];
};
/** Persisted ledger state (bigints as decimal strings). */
export type LedgerData = { buckets: Record<string, Bucket>; reservations: Record<string, Reservation> };

export const emptyLedger = (): LedgerData => ({ buckets: {}, reservations: {} });

/** One level's allowance for a reservation (see LevelAllowance in grant.ts). */
export type LedgerLevel = {
  name: string;
  node: Hex;
  resource: string | null;
  /** Null = no aggregate limit at this level (not tracked). */
  limit: { base: bigint; period: Period } | null;
  /** Overlay bucket ("approval:<id>"); replaces the calendar period key. */
  bucket?: string | null;
};

export type ReserveResult =
  | { ok: true; id: string; replay: boolean }
  | { ok: false; level: string; remaining: bigint; limit: bigint; reason: string };

export type LevelUsage = { name: string; key: string; limit: bigint; spent: bigint; reserved: bigint; remaining: bigint; period: Period | "approval" };

/** Where the ledger's data lives. `write` must persist durably or throw (the ledger then changes nothing). */
export interface LedgerIO {
  read(): LedgerData;
  write(next: LedgerData): void;
}

/** Bucket key for a level. */
export function ledgerKey(node: Hex, resource: string | null, token: string, bucket: string): string {
  return `chain:${node.toLowerCase()}:${resource ?? "-"}:${token.toLowerCase()}:${bucket}`;
}

const big = (s: string | undefined) => (s ? BigInt(s) : 0n);
const RESERVATION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export class Ledger {
  constructor(
    private readonly io: LedgerIO,
    /** Token address the buckets are for (the workspace token). */
    private readonly token: string,
  ) {}

  private keysFor(levels: LedgerLevel[], now: Date): { key: string; name: string; limit: bigint; period: Period | "approval" }[] {
    const byKey = new Map<string, { key: string; name: string; limit: bigint; period: Period | "approval" }>();
    for (const l of levels) {
      if (!l.limit) continue;
      const bucket = l.bucket ?? periodKey(l.limit.period, now);
      const key = ledgerKey(l.node, l.resource, this.token, bucket);
      const prev = byKey.get(key);
      // The same bucket listed twice is one ledger: reserve once, against the smaller limit.
      if (!prev || l.limit.base < prev.limit) byKey.set(key, { key, name: l.name, limit: l.limit.base, period: l.bucket ? "approval" : l.limit.period });
    }
    return [...byKey.values()];
  }

  /**
   * Reserves `amount` at every limited level, or at none. Replaying an id that
   * is reserved or committed returns ok (no second reservation); a released id
   * is refused (a fresh reservation needs a fresh id).
   */
  reserve(levels: LedgerLevel[], amount: bigint, id: string, now: Date = new Date()): ReserveResult {
    if (!RESERVATION_ID.test(id)) return { ok: false, level: "", remaining: 0n, limit: 0n, reason: "invalid reservation id" };
    if (amount <= 0n) return { ok: false, level: "", remaining: 0n, limit: 0n, reason: "amount must be more than zero" };
    const data = this.io.read();
    const existing = data.reservations[id];
    if (existing) {
      if (existing.state === "released") return { ok: false, level: "", remaining: 0n, limit: 0n, reason: `reservation ${id} was released` };
      if (big(existing.amount) !== amount) return { ok: false, level: "", remaining: 0n, limit: 0n, reason: `reservation ${id} exists with another amount` };
      return { ok: true, id, replay: true };
    }
    const keys = this.keysFor(levels, now);
    // Check every level first…
    for (const k of keys) {
      const b = data.buckets[k.key];
      const used = big(b?.spent) + big(b?.reserved);
      if (used + amount > k.limit) {
        const remaining = k.limit > used ? k.limit - used : 0n;
        return { ok: false, level: k.name, remaining, limit: k.limit, reason: `over ${k.name}'s allowance: ${remaining} base units left of ${k.limit}` };
      }
    }
    // …then reserve at all of them in one write.
    const next: LedgerData = { buckets: { ...data.buckets }, reservations: { ...data.reservations } };
    for (const k of keys) {
      const b = next.buckets[k.key] ?? { spent: "0", reserved: "0" };
      next.buckets[k.key] = { spent: b.spent, reserved: (big(b.reserved) + amount).toString() };
    }
    next.reservations[id] = { amount: amount.toString(), keys: keys.map((k) => k.key), state: "reserved", at: Math.floor(now.getTime() / 1000), names: keys.map((k) => k.name) };
    this.io.write(next);
    return { ok: true, id, replay: false };
  }

  /** Moves a reservation into spent. True if it is (now or already) committed; false if unknown or released. */
  commit(id: string): boolean {
    return this.settle(id, "committed");
  }

  /** Drops a reservation. True if it is (now or already) released; false if unknown or already committed. */
  release(id: string): boolean {
    return this.settle(id, "released");
  }

  private settle(id: string, to: "committed" | "released"): boolean {
    const data = this.io.read();
    const r = data.reservations[id];
    if (!r) return false;
    if (r.state === to) return true;
    if (r.state !== "reserved") return false;
    const amount = big(r.amount);
    const next: LedgerData = { buckets: { ...data.buckets }, reservations: { ...data.reservations, [id]: { ...r, state: to } } };
    for (const key of r.keys) {
      const b = next.buckets[key] ?? { spent: "0", reserved: "0" };
      const reserved = big(b.reserved) - amount;
      next.buckets[key] = {
        spent: (to === "committed" ? big(b.spent) + amount : big(b.spent)).toString(),
        reserved: (reserved > 0n ? reserved : 0n).toString(),
      };
    }
    this.io.write(next);
    return true;
  }

  /** A reservation's state, or null. */
  reservation(id: string): Reservation | null {
    return this.io.read().reservations[id] ?? null;
  }

  /** Current usage at each limited level (for the UI and activity log). */
  usage(levels: LedgerLevel[], now: Date = new Date()): LevelUsage[] {
    const data = this.io.read();
    return this.keysFor(levels, now).map((k) => {
      const b = data.buckets[k.key];
      const spent = big(b?.spent);
      const reserved = big(b?.reserved);
      const left = k.limit - spent - reserved;
      return { name: k.name, key: k.key, limit: k.limit, spent, reserved, remaining: left > 0n ? left : 0n, period: k.period };
    });
  }
}

/** An in-memory LedgerIO (tests, and a Ledger over a store's snapshot). */
export function memoryLedgerIO(initial: LedgerData = emptyLedger()): LedgerIO & { data: LedgerData } {
  const io = {
    data: initial,
    read: () => io.data,
    write: (next: LedgerData) => {
      io.data = next;
    },
  };
  return io;
}
