// Spend meter, usage counts and decision log, kept in memory and persisted to
// <RELAY_DATA_DIR>/relay.json with a debounced atomic write (tmp file, fsync,
// rename), so it survives restarts.
//
// Spend (dollars) and counts (requests, or images) are keyed per level as
// "<namehash>:<resource>|<provider>|<period>". The registry's EAC resource
// changes when a label is unregistered and registered again, so a re-hired
// label starts from zero.
//
// Calls in flight hold a reservation (their worst-case cost and count) against
// the same keys until they settle, so concurrent calls can't overrun a cap.
//
// The file also keeps the name behind each namehash (so removed names can be
// found and cleared) and the gas funder's grants (POST /api/fund).
//
// SINGLE INSTANCE ONLY: spend and reservations live in this process. Two relay
// processes (or serverless instances) sharing a root would each enforce caps
// on their own spend. If the file can't be read or saved, the meter reports
// itself unavailable and the relay refuses metered calls instead of starting
// from $0.

import fs from "node:fs";
import path from "node:path";

import type { Address, Hex } from "viem";

import type { LogEntry } from "./types";

export const LOG_LIMIT = 500;
const SAVE_RETRY_MS = 5_000;

/** One payment from the gas funder. */
export type Grant = {
  name: string;
  /** EAC resource of the name when funded: a re-registered name can be funded again. */
  resource: string;
  address: Address;
  /** Wei, as a decimal string. */
  amountWei: string;
  txHash: Hex;
  ts: number;
};

type StoreFile = {
  version: 1;
  spend: Record<string, number>;
  counts?: Record<string, number>;
  names?: Record<string, string>;
  grants?: Grant[];
  /** "name|resource" of every grant ever made, uncapped (the grant list above keeps only the latest). */
  granted?: string[];
  log: LogEntry[];
};

export const spendKey = (node: Hex, resource: string | null, provider: string, period: string) =>
  `${node}:${resource ?? "0"}|${provider}|${period}`;

/** The namehash and resource a spend key belongs to. */
export function parseSpendKey(key: string): { node: string; resource: string } | null {
  const m = key.match(/^(0x[0-9a-fA-F]+):([^|]*)\|/);
  return m ? { node: m[1].toLowerCase(), resource: m[2] } : null;
}

const round = (usd: number) => Math.round(usd * 1e9) / 1e9;

/** Most grants kept in the file (only today's matter for the daily limit; the rest are history). */
const GRANT_LIMIT = 2000;

const grantKey = (name: string, resource: string) => `${name}|${resource}`;

export class Meter {
  private spend = new Map<string, number>();
  /** Reserved (in-flight) dollars per spend key. */
  private held = new Map<string, number>();
  /** Settled counts (requests or images) per spend key. */
  private counts = new Map<string, number>();
  /** Reserved (in-flight) counts per spend key. */
  private heldCounts = new Map<string, number>();
  /** Namehash (lowercase) -> name, for every level that was ever charged. */
  private names = new Map<string, string>();
  private grantList: Grant[] = [];
  /** "name|resource" of every grant, so "once per registration" holds after old grants leave the list. */
  private grantedKeys = new Set<string>();
  /** Calls in flight per name. */
  private active = new Map<string, number>();
  /** Oldest first. */
  private entries: LogEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;
  /** Requests refused before the caller proved it owns a name (not written to the log). */
  private rejected = 0;
  /** Set when the file exists but can't be read: nothing is saved over it and metered calls are refused. */
  readonly broken: string | null = null;
  private saveError: string | null = null;

  constructor(
    readonly file: string,
    private readonly debounceMs = 250,
  ) {
    this.broken = this.load();
  }

  private load(): string | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; // first run
      return `${this.file} can't be read (${(err as Error).message})`;
    }
    let data: Partial<StoreFile>;
    try {
      data = JSON.parse(raw);
      if (!data || typeof data !== "object" || typeof data.spend !== "object" || data.spend === null) throw new Error("no spend table");
    } catch (err) {
      return `${this.file} is damaged (${err instanceof Error ? err.message : String(err)}). Restore it from a backup or move it aside, then restart the relay.`;
    }
    for (const [k, v] of Object.entries(data.spend ?? {})) if (typeof v === "number" && Number.isFinite(v)) this.spend.set(k, v);
    for (const [k, v] of Object.entries(data.counts ?? {})) if (typeof v === "number" && Number.isFinite(v)) this.counts.set(k, v);
    for (const [k, v] of Object.entries(data.names ?? {})) if (typeof v === "string") this.names.set(k.toLowerCase(), v);
    if (Array.isArray(data.granted)) for (const k of data.granted) if (typeof k === "string") this.grantedKeys.add(k);
    if (Array.isArray(data.grants)) {
      const valid = data.grants.filter((g) => g && typeof g.name === "string" && typeof g.amountWei === "string");
      for (const g of valid) this.grantedKeys.add(grantKey(g.name, g.resource));
      this.grantList = valid.slice(-GRANT_LIMIT);
    }
    if (Array.isArray(data.log)) this.entries = data.log.slice(-LOG_LIMIT);
    return null;
  }

  /** Why metered calls must be refused right now, or null when spend is being recorded safely. */
  unavailable(): string | null {
    return this.broken ?? (this.saveError ? `the relay can't save spend to ${this.file} (${this.saveError})` : null);
  }

  /** Dollars recorded for a key (settled calls only). */
  spent(key: string): number {
    return this.spend.get(key) ?? 0;
  }

  /** Dollars reserved by calls still in flight. */
  pending(key: string): number {
    return this.held.get(key) ?? 0;
  }

  add(key: string, usd: number) {
    if (!Number.isFinite(usd) || usd <= 0) return;
    // Round to a billionth of a dollar to keep float noise out of the file.
    this.spend.set(key, round(this.spent(key) + usd));
    this.schedule();
  }

  /** Count recorded for a key (settled calls only). */
  used(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /** Count reserved by calls still in flight. */
  pendingCount(key: string): number {
    return this.heldCounts.get(key) ?? 0;
  }

  addCount(key: string, n: number) {
    if (!Number.isFinite(n) || n <= 0) return;
    this.counts.set(key, this.used(key) + n);
    this.schedule();
  }

  /** Reserves `usd` and `count` on every key; the returned function releases both (once). */
  hold(keys: string[], usd: number, count = 0): () => void {
    const u = usd > 0 ? usd : 0;
    const c = count > 0 ? count : 0;
    if (!u && !c) return () => {};
    for (const k of keys) {
      if (u) this.held.set(k, round(this.pending(k) + u));
      if (c) this.heldCounts.set(k, this.pendingCount(k) + c);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const k of keys) {
        if (u) {
          const left = round(this.pending(k) - u);
          if (left > 0) this.held.set(k, left);
          else this.held.delete(k);
        }
        if (c) {
          const left = this.pendingCount(k) - c;
          if (left > 0) this.heldCounts.set(k, left);
          else this.heldCounts.delete(k);
        }
      }
    };
  }

  /** Remembers which name a namehash stands for (saved with the next write). */
  remember(node: string, name: string) {
    const k = node.toLowerCase();
    if (this.names.get(k) === name) return;
    this.names.set(k, name);
    this.schedule();
  }

  /** Every name that has spend or counts recorded, with the resources they were recorded under. */
  meteredNames(): { node: string; name: string | null; resources: string[] }[] {
    const byNode = new Map<string, Set<string>>();
    for (const key of [...this.spend.keys(), ...this.counts.keys(), ...this.held.keys(), ...this.heldCounts.keys()]) {
      const parsed = parseSpendKey(key);
      if (!parsed) continue;
      let set = byNode.get(parsed.node);
      if (!set) byNode.set(parsed.node, (set = new Set()));
      set.add(parsed.resource);
    }
    return [...byNode].map(([node, resources]) => ({ node, name: this.names.get(node) ?? null, resources: [...resources] }));
  }

  /**
   * Clears spend, counts and reservations of a namehash: every resource, or
   * only those `keep` returns false for. Returns how many keys were removed.
   */
  clearNode(node: string, keep: (resource: string) => boolean = () => false): number {
    const n = node.toLowerCase();
    let removed = 0;
    for (const table of [this.spend, this.counts, this.held, this.heldCounts]) {
      for (const key of [...table.keys()]) {
        const parsed = parseSpendKey(key);
        if (!parsed || parsed.node !== n || keep(parsed.resource)) continue;
        table.delete(key);
        if (table === this.spend || table === this.counts) removed++;
      }
    }
    if (removed) this.schedule();
    return removed;
  }

  /** Distinct names in the decision log. */
  loggedNames(): string[] {
    return [...new Set(this.entries.map((e) => e.name).filter((n): n is string => !!n))];
  }

  /** Removes the log entries of these names; returns how many were removed. */
  trimLog(names: Set<string>): number {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !(e.name && names.has(e.name)));
    const removed = before - this.entries.length;
    if (removed) this.schedule();
    return removed;
  }

  grants(): Grant[] {
    return [...this.grantList];
  }

  /** True when `name` was funded before under this registration (EAC resource). */
  hasGrant(name: string, resource: string): boolean {
    return this.grantedKeys.has(grantKey(name, resource));
  }

  addGrant(grant: Grant) {
    this.grantedKeys.add(grantKey(grant.name, grant.resource));
    this.grantList.push(grant);
    if (this.grantList.length > GRANT_LIMIT) this.grantList.splice(0, this.grantList.length - GRANT_LIMIT);
    this.schedule();
  }

  /** Takes an in-flight slot for `key` if fewer than `max` are taken. */
  enter(key: string, max: number): boolean {
    const n = this.active.get(key) ?? 0;
    if (n >= max) return false;
    this.active.set(key, n + 1);
    return true;
  }

  leave(key: string) {
    const n = (this.active.get(key) ?? 0) - 1;
    if (n > 0) this.active.set(key, n);
    else this.active.delete(key);
  }

  inFlight(key: string): number {
    return this.active.get(key) ?? 0;
  }

  log(entry: LogEntry) {
    this.entries.push(entry);
    if (this.entries.length > LOG_LIMIT) this.entries.splice(0, this.entries.length - LOG_LIMIT);
    this.schedule();
  }

  /** Counts a request refused before its caller proved it owns a name. Kept out of the log so junk can't flush it. */
  countRejected() {
    this.rejected++;
  }

  get rejectedCount() {
    return this.rejected;
  }

  /** Newest first. */
  recent(limit = 100): LogEntry[] {
    const n = Math.max(0, Math.min(Math.floor(limit), LOG_LIMIT));
    return n === 0 ? [] : this.entries.slice(-n).reverse();
  }

  private snapshot(): string {
    const data: StoreFile = {
      version: 1,
      spend: Object.fromEntries(this.spend),
      counts: Object.fromEntries(this.counts),
      names: Object.fromEntries(this.names),
      grants: this.grantList,
      granted: [...this.grantedKeys],
      log: this.entries,
    };
    return JSON.stringify(data);
  }

  private schedule(delay = this.debounceMs) {
    this.dirty = true;
    if (this.timer || this.broken) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
    this.timer.unref?.();
  }

  /** Writes pending changes now. Resolves when they are on disk. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.writing = this.writing.then(async () => {
      if (!this.dirty || this.broken) return;
      this.dirty = false;
      const tmp = `${this.file}.${process.pid}.tmp`;
      try {
        await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
        const fh = await fs.promises.open(tmp, "w", 0o600);
        try {
          await fh.writeFile(this.snapshot());
          // Without fsync a crash can leave an empty relay.json behind the rename.
          await fh.sync();
        } finally {
          await fh.close();
        }
        await fs.promises.rename(tmp, this.file);
        await syncDir(path.dirname(this.file));
        this.saveError = null;
      } catch (err) {
        this.saveError = err instanceof Error ? err.message : String(err);
        console.error("[relay] could not save meter:", this.saveError);
        this.schedule(SAVE_RETRY_MS);
      }
    });
    return this.writing;
  }

  /** Synchronous save, for process exit. */
  flushSync() {
    if (!this.dirty || this.broken) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      const fd = fs.openSync(tmp, "w", 0o600);
      try {
        fs.writeFileSync(fd, this.snapshot());
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch {}
  }
}

/** fsync the directory so the rename itself survives a crash (best effort; not every platform allows it). */
async function syncDir(dir: string) {
  try {
    const fh = await fs.promises.open(dir, "r");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {}
}

// One meter per data file, kept on globalThis so dev-server reloads share it.
const g = globalThis as unknown as { __relayMeters?: Map<string, Meter>; __relayMeterExitHook?: boolean };

export function getMeter(dataDir: string): Meter {
  const file = path.resolve(dataDir, "relay.json");
  g.__relayMeters ??= new Map();
  let meter = g.__relayMeters.get(file);
  if (!(meter instanceof Meter)) {
    // After a dev-server reload of this module: save what the old instance holds, then reload it.
    // Reservations of calls still running in the old instance are dropped with it.
    (meter as { flushSync?: () => void } | undefined)?.flushSync?.();
    meter = new Meter(file);
    g.__relayMeters.set(file, meter);
  }
  if (!g.__relayMeterExitHook) {
    g.__relayMeterExitHook = true;
    process.once("exit", () => g.__relayMeters?.forEach((m) => m.flushSync()));
  }
  return meter;
}
