// The approvals store: <RELAY_DATA_DIR>/approvals.json. Incidents,
// suspensions, approved-scope overlays, baselines, cleared renewals
// (expects), challenges, linked approvers and the audit trail.
//
// Kept in memory and written synchronously (tmp file, fsync, rename, mode
// 0600) inside `commit()`, so an answer is only sent once the state is on
// disk. A file that exists but can't be read makes the store unavailable:
// nothing is saved over it and the guard fails closed. SINGLE INSTANCE ONLY,
// like the meter.

import fs from "node:fs";
import path from "node:path";

import type { Address, Hex } from "viem";

import type { Bundle } from "../bundle";
import type { LogEntry } from "../types";
import type { Flag, NarrowScope, Suggested } from "./rules";
import type { ScopeView } from "./scope";

export const APPROVALS_FILE = "approvals.json";
const AUDIT_LIMIT = 1000;
const CHALLENGE_KEEP_SEC = 7 * 86400;

export type Decision = "approve" | "approve-narrower" | "reject" | "revoke";
export type Subject = { kind: "incident"; id: string } | { kind: "proposal"; id: string };

export type IncidentState = "open" | "resolved:approved" | "resolved:approved-narrower" | "resolved:rejected" | "resolved:revoked" | "expired";

export type WorldEvidence = { nullifier: Hex; environment: string; presence: "client-reported" | "not-requested"; verifiedAt: number };

export type Incident = {
  id: string;
  root: string;
  revision: number;
  state: IncidentState;
  /** "<namehash>:<resource>" of the subject. */
  key: string;
  subject: { name: string; node: Hex; resource: string; owner: Address | null; parent: string };
  trigger: { source: "renewal-request" | "drift" | "agent-report"; requestedBy: string | null; at: number };
  previous: ScopeView & { source: Baseline["source"] };
  proposed: ScopeView | null;
  flags: Flag[];
  evidence: { log: LogEntry[]; refusedChain: LogEntry[] };
  affected: { name: string; relation: "subject" | "below" }[];
  affectedPartial: boolean;
  agentReports: { by: string; category: string; text: string; at: number; untrusted: true }[];
  suggested: Suggested[];
  policyVersion: string;
  remediation: "not assessed";
  resolution: null | { decision: Decision; approver: Address; digest: Hex; world: WorldEvidence | null; at: number; overlayId: string | null };
  events: { at: number; kind: string; by: string; detail: string }[];
  /** Hash of the subject's chain scope when the incident last changed (drift re-opens on a new one). */
  chainHash: string;
  openedAt: number;
  reviewBy: number;
  /** Set by the admin round reset (unix s): kept for the audit trail, left out of the list unless asked for. */
  archivedAt?: number;
};

export type Suspension = { incidentId: string; name: string; since: number; permanent: boolean };

export type StoredOverlay = {
  id: string;
  key: string;
  name: string;
  incidentId: string;
  bundle: Bundle | null;
  chain: string | null;
  notAfter: number;
  bucket: string;
  approver: Address;
  digest: Hex;
  at: number;
};

export type Baseline = {
  name: string;
  scope: ScopeView;
  /** When this scope started (to size the previous term for R5). */
  at: number;
  /** The chain scope last accepted for this key (drift compares the chain with it). */
  chainHash: string;
  source: "first-seen" | "cleared" | "approval";
};

export type Expect = { id: string; key: string; name: string; scope: ScopeView; expiresAt: number; requestedBy: string };

export type ChallengeStatus = "issued" | "verifying" | "consumed" | "failed" | "cancelled" | "expired";

export type Challenge = {
  id: string;
  kind: "decision" | "enroll" | "unlink";
  approver: Address;
  status: ChallengeStatus;
  message: string;
  digest: Hex;
  issuedAt: number;
  expiresAt: number;
  /** decision challenges */
  subject?: Subject;
  revision?: number;
  decision?: Decision;
  scope?: NarrowScope | null;
  proposalDigest?: Hex;
  notAfter?: number | null;
  /** World request, when World is required. */
  world?: { signal: string; rpNonce: Hex } | null;
  failure?: string;
  /** unlink challenges: the approver being unlinked. */
  target?: Address;
};

export type Approver = { nullifier: Hex; linkedAt: number; linkSig: Hex; challengeId: string };

export type AuditEvent = { at: number; kind: string; by: string; subject: string | null; detail: string };

export type StoreData = {
  v: 1;
  incidents: Record<string, Incident>;
  suspensions: Record<string, Suspension>;
  overlays: Record<string, StoredOverlay>;
  baselines: Record<string, Baseline>;
  expects: Record<string, Expect>;
  challenges: Record<string, Challenge>;
  approvers: Record<string, Approver>;
  nullifierIndex: Record<string, Address>;
  /** Reporter name → times (unix s) it opened an incident, for the 3-per-hour limit. */
  reports: Record<string, number[]>;
  audit: AuditEvent[];
};

const empty = (): StoreData => ({
  v: 1,
  incidents: {},
  suspensions: {},
  overlays: {},
  baselines: {},
  expects: {},
  challenges: {},
  approvers: {},
  nullifierIndex: {},
  reports: {},
  audit: [],
});

const TABLES = ["incidents", "suspensions", "overlays", "baselines", "expects", "challenges", "approvers", "nullifierIndex", "reports"] as const;

export class ApprovalsStore {
  data: StoreData = empty();
  /** Set when the file exists but can't be read: nothing is saved over it. */
  readonly broken: string | null;
  private saveError: string | null = null;

  constructor(readonly file: string) {
    this.broken = this.load();
  }

  private load(): string | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      return `${this.file} can't be read (${(err as Error).message})`;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoreData>;
      if (!parsed || typeof parsed !== "object" || parsed.v !== 1) throw new Error("not a version 1 approvals file");
      for (const t of TABLES) {
        const v = parsed[t];
        if (v !== undefined && (!v || typeof v !== "object" || Array.isArray(v))) throw new Error(`${t} is not a table`);
      }
      if (parsed.audit !== undefined && !Array.isArray(parsed.audit)) throw new Error("audit is not a list");
      this.data = { ...empty(), ...parsed } as StoreData;
      return null;
    } catch (err) {
      return `${this.file} is damaged (${err instanceof Error ? err.message : String(err)}). Restore it or move it aside, then restart the relay.`;
    }
  }

  /** Why decisions must fail closed right now, or null. */
  unavailable(): string | null {
    return this.broken ?? (this.saveError ? `can't save ${this.file} (${this.saveError})` : null);
  }

  /**
   * Runs `fn` against the data and saves synchronously. If `fn` throws or the
   * save fails, the in-memory data is restored and the error rethrown, so
   * nothing half-applied is ever visible or answered.
   */
  commit<T>(fn: (d: StoreData) => T): T {
    if (this.broken) throw new Error(this.broken);
    const before = structuredClone(this.data);
    try {
      const out = fn(this.data);
      this.save();
      return out;
    } catch (err) {
      this.data = before;
      throw err;
    }
  }

  /** Like commit, but never throws: for the guard's observe() (drift), which must not break decide(). */
  tryCommit(fn: (d: StoreData) => void): boolean {
    try {
      this.commit(fn);
      return true;
    } catch {
      return false;
    }
  }

  private save() {
    this.prune();
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const fd = fs.openSync(tmp, "w", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(this.data));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.file);
      this.saveError = null;
    } catch (err) {
      this.saveError = err instanceof Error ? err.message : String(err);
      throw new Error(`approvals store unavailable: ${this.saveError}`);
    }
  }

  private prune() {
    const d = this.data;
    const nowSec = Math.floor(Date.now() / 1000);
    if (d.audit.length > AUDIT_LIMIT) d.audit.splice(0, d.audit.length - AUDIT_LIMIT);
    for (const [id, c] of Object.entries(d.challenges)) if (c.expiresAt + CHALLENGE_KEEP_SEC < nowSec) delete d.challenges[id];
    for (const [id, e] of Object.entries(d.expects)) if (e.expiresAt < nowSec) delete d.expects[id];
    for (const [who, times] of Object.entries(d.reports)) {
      const kept = times.filter((t) => t > nowSec - 3600);
      if (kept.length) d.reports[who] = kept;
      else delete d.reports[who];
    }
  }
}

// One store per file, on globalThis so every bundle and dev-server reload shares it.
const g = globalThis as unknown as { __relayApprovals?: Map<string, ApprovalsStore> };

export function getApprovalsStore(dataDir: string): ApprovalsStore {
  const file = path.resolve(dataDir, APPROVALS_FILE);
  g.__relayApprovals ??= new Map();
  let store = g.__relayApprovals.get(file);
  if (!store) {
    store = new ApprovalsStore(file);
    g.__relayApprovals.set(file, store);
  }
  return store;
}
