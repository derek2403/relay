// Relay-side blockchain state: proposals, the allowance ledger, relay-deployed
// escrows, seen-event dedupe keys and recent task runs, in
// <RELAY_DATA_DIR>/chain.json.
//
// Writes are synchronous and atomic (tmp file + fsync + rename, mode 0600):
// every change goes through update(), which applies it to a copy, persists the
// copy and only then swaps it in, so a failed write changes nothing. A file
// that can't be read or parsed makes the store unavailable: every read-for-
// decision and every write is refused (fail closed) and the file is never
// overwritten, so an operator can inspect or restore it.
//
// One store per file, kept on globalThis so every bundle and dev-server reload
// shares it (and its in-process critical sections).

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Address, Hex } from "viem";

import { loadConfig } from "../relay/config";
import { Ledger, type LedgerData, type LedgerIO, emptyLedger } from "./ledger";
import { type Proposal, type ProposalState, TRANSITIONS, findByRequest } from "./proposals";

export const CHAIN_FILE = "chain.json";
export const MAX_RUNS_PER_AGENT = 50;
export const MAX_SEEN = 10_000;

/** An escrow the relay deployed from the approved template. */
export type DeployedEscrow = {
  address: Address;
  /** Agent name that proposed the deploy. */
  deployedBy: string;
  proposalId: string;
  admin: Address;
  payee: Address;
  /** STD decimal string. */
  amount: string;
  txHash: Hex;
  block: number;
  /** MultiBaas alias, e.g. "relay-escrow-1". */
  alias?: string;
};

/** One planner run (task text, plan, results), kept for the agent's history. */
export type TaskRun = { id: string; at: number; task: string; plan: unknown; results: unknown; report: string | null };

export type ChainStoreData = {
  v: 1;
  proposals: Record<string, Proposal>;
  ledger: LedgerData;
  escrows: DeployedEscrow[];
  /** Dedupe keys of events already processed → unix seconds first seen. */
  seen: Record<string, number>;
  /** Last runs per agent name, oldest first. */
  runs: Record<string, TaskRun[]>;
};

export const emptyChainData = (): ChainStoreData => ({ v: 1, proposals: {}, ledger: emptyLedger(), escrows: [], seen: {}, runs: {} });

export class ChainStoreError extends Error {
  constructor(
    readonly status: 503 | 409 | 404,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ChainStoreError";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const DIGITS = /^\d+$/;
const STATES = Object.keys(TRANSITIONS) as ProposalState[];
const TOP_KEYS = ["v", "proposals", "ledger", "escrows", "seen", "runs"];

/** Validates the file's shape; throws with a short reason when anything is off (unknown top-level keys included). */
export function parseChainData(raw: unknown): ChainStoreData {
  if (!isObj(raw)) throw new Error("not an object");
  const extra = Object.keys(raw).find((k) => !TOP_KEYS.includes(k));
  if (extra) throw new Error(`unknown field ${JSON.stringify(extra)}`);
  if (raw.v !== 1) throw new Error("unsupported version");
  const { proposals, ledger, escrows, seen, runs } = raw;
  if (!isObj(proposals) || !isObj(ledger) || !Array.isArray(escrows) || !isObj(seen) || !isObj(runs)) throw new Error("missing sections");
  for (const [id, p] of Object.entries(proposals)) {
    if (!isObj(p) || p.id !== id || typeof p.requestId !== "string" || !STATES.includes(p.state as ProposalState) || !isObj(p.agent) || !Array.isArray(p.events))
      throw new Error(`proposal ${id.slice(0, 40)} is malformed`);
  }
  if (!isObj(ledger.buckets) || !isObj(ledger.reservations)) throw new Error("ledger is malformed");
  for (const b of Object.values(ledger.buckets)) if (!isObj(b) || !DIGITS.test(String(b.spent)) || !DIGITS.test(String(b.reserved))) throw new Error("ledger bucket is malformed");
  for (const r of Object.values(ledger.reservations))
    if (!isObj(r) || !DIGITS.test(String(r.amount)) || !Array.isArray(r.keys) || !["reserved", "committed", "released"].includes(r.state as string))
      throw new Error("ledger reservation is malformed");
  for (const e of escrows) if (!isObj(e) || typeof e.address !== "string" || typeof e.proposalId !== "string") throw new Error("escrow entry is malformed");
  for (const v of Object.values(seen)) if (typeof v !== "number") throw new Error("seen entry is malformed");
  for (const list of Object.values(runs)) if (!Array.isArray(list)) throw new Error("runs are malformed");
  return raw as unknown as ChainStoreData;
}

function syncDir(dir: string) {
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
}

export class ChainStore {
  private data: ChainStoreData = emptyChainData();
  private error: string | null = null;

  constructor(readonly file: string) {
    this.load();
  }

  private load() {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // a fresh store
      this.error = `${this.file} can't be read (${(err as NodeJS.ErrnoException).code ?? "error"})`;
      return;
    }
    try {
      this.data = parseChainData(JSON.parse(raw));
    } catch (err) {
      this.error = `${this.file} is damaged (${err instanceof Error ? err.message : "unparseable"}). Restore it or move it aside, then restart the relay.`;
    }
  }

  /** Why the store can't be used, or null. Callers deny chain actions while this is non-null. */
  unavailable(): string | null {
    return this.error;
  }

  private assertUsable() {
    if (this.error) throw new ChainStoreError(503, "chain_store_unavailable", this.error);
  }

  private persist(next: ChainStoreData) {
    const body = JSON.stringify(next);
    const dir = path.dirname(this.file);
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const fd = fs.openSync(tmp, "w", 0o600);
      try {
        fs.writeFileSync(fd, body);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.file);
      try {
        fs.chmodSync(this.file, 0o600);
      } catch {}
      syncDir(dir);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {}
      throw new ChainStoreError(503, "chain_store_write_failed", `could not write ${this.file} (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    }
  }

  /**
   * Applies `fn` to a copy of the data, persists it, then swaps it in. Fully
   * synchronous: no other store change can interleave. Throws (changing
   * nothing) when the store is unavailable, `fn` throws, or the write fails.
   */
  update<T>(fn: (draft: ChainStoreData) => T): T {
    this.assertUsable();
    const draft = structuredClone(this.data);
    const out = fn(draft);
    this.persist(draft);
    this.data = draft;
    return out;
  }

  /** A read-only view of the current data (throws when unavailable). */
  snapshot(): Readonly<ChainStoreData> {
    this.assertUsable();
    return this.data;
  }

  // --- Proposals ---

  proposal(id: string): Proposal | null {
    this.assertUsable();
    return Object.hasOwn(this.data.proposals, id) ? this.data.proposals[id] : null;
  }

  proposals(filter?: (p: Proposal) => boolean): Proposal[] {
    this.assertUsable();
    const all = Object.values(this.data.proposals).sort((a, b) => b.createdAt - a.createdAt);
    return filter ? all.filter(filter) : all;
  }

  findRequest(agentName: string, requestId: string): Proposal | null {
    this.assertUsable();
    return findByRequest(Object.values(this.data.proposals), agentName, requestId);
  }

  /**
   * Inserts a new proposal unless this agent already used its requestId, in
   * which case the existing one is returned (`created: false`).
   */
  addProposal(p: Proposal): { proposal: Proposal; created: boolean } {
    return this.update((d) => {
      const existing = findByRequest(Object.values(d.proposals), p.agent.name, p.requestId);
      if (existing) return { proposal: existing, created: false };
      if (Object.hasOwn(d.proposals, p.id)) throw new ChainStoreError(409, "duplicate_id", `proposal ${p.id} exists`);
      d.proposals[p.id] = p;
      return { proposal: p, created: true };
    });
  }

  /**
   * Replaces a proposal with `fn(current)` atomically (fn may throw, e.g. an
   * illegal transition, and then nothing changes). Returns the new proposal.
   */
  updateProposal(id: string, fn: (p: Proposal) => Proposal): Proposal {
    return this.update((d) => {
      const p = Object.hasOwn(d.proposals, id) ? d.proposals[id] : null;
      if (!p) throw new ChainStoreError(404, "not_found", `no proposal ${id}`);
      const next = fn(p);
      if (next.id !== id) throw new Error("proposal id can't change");
      d.proposals[id] = next;
      return next;
    });
  }

  // --- Ledger ---

  /**
   * The allowance ledger for `token`, backed by this store: each reserve /
   * commit / release is one synchronous persisted update.
   */
  ledger(token: string): Ledger {
    const io: LedgerIO = {
      read: () => this.snapshot().ledger,
      write: (next) => {
        this.update((d) => {
          d.ledger = next;
        });
      },
    };
    return new Ledger(io, token);
  }

  // --- Escrows ---

  escrows(): DeployedEscrow[] {
    this.assertUsable();
    return [...this.data.escrows];
  }

  /** Records a deployed escrow (idempotent by address); gives it the next alias when none is set. */
  addEscrow(e: DeployedEscrow): DeployedEscrow {
    return this.update((d) => {
      const existing = d.escrows.find((x) => x.address.toLowerCase() === e.address.toLowerCase());
      if (existing) return existing;
      const entry = { ...e, alias: e.alias ?? `relay-escrow-${d.escrows.length + 1}` };
      d.escrows.push(entry);
      return entry;
    });
  }

  // --- Seen events ---

  /** True the first time `key` is seen (and records it); false afterwards. Keeps the newest MAX_SEEN keys. */
  markSeen(key: string, at: number = Math.floor(Date.now() / 1000)): boolean {
    this.assertUsable();
    if (Object.hasOwn(this.data.seen, key)) return false;
    this.update((d) => {
      d.seen[key] = at;
      const keys = Object.keys(d.seen);
      if (keys.length > MAX_SEEN) {
        keys.sort((a, b) => d.seen[a] - d.seen[b]);
        for (const k of keys.slice(0, keys.length - MAX_SEEN)) delete d.seen[k];
      }
    });
    return true;
  }

  // --- Task runs ---

  addRun(agentName: string, run: TaskRun): void {
    this.update((d) => {
      const list = Object.hasOwn(d.runs, agentName) ? d.runs[agentName] : [];
      d.runs[agentName] = [...list, run].slice(-MAX_RUNS_PER_AGENT);
    });
  }

  runs(agentName: string): TaskRun[] {
    this.assertUsable();
    return Object.hasOwn(this.data.runs, agentName) ? [...this.data.runs[agentName]] : [];
  }
}

const g = globalThis as unknown as { __relayChainStores?: Map<string, ChainStore> };

export const chainFile = (dataDir: string) => path.resolve(dataDir, CHAIN_FILE);

/** The process-wide store for RELAY_DATA_DIR. */
export function chainStore(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): ChainStore {
  const file = chainFile(loadConfig(env).dataDir);
  g.__relayChainStores ??= new Map();
  let s = g.__relayChainStores.get(file);
  if (!s) g.__relayChainStores.set(file, (s = new ChainStore(file)));
  return s;
}

/** Drops cached stores (tests). */
export function resetChainStores() {
  g.__relayChainStores?.clear();
}
