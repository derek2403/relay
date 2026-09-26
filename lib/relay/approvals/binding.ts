// What an approver signs: a canonical JSON binding of the exact decision
// (subject, revision, target, decision, scope or proposal digest, policy
// version, approver, challenge, times), its keccak256 digest, and a
// human-readable wallet message that names all of it. The World proof's
// signal carries the same digest. Pure: no I/O.

import { type Address, type Hex, keccak256, stringToBytes } from "viem";

import { describeBundle } from "../bundle";
import type { NarrowScope } from "./rules";
import { chainScopeText } from "./scope";
import type { Decision, Subject } from "./store";

export type Binding = {
  v: 1;
  root: string;
  subject: Subject & { revision: number };
  target: { name: string; node: Hex; resource: string; owner: Address | null };
  decision: Decision;
  scope?: NarrowScope | null;
  proposalDigest?: Hex;
  notAfter?: number | null;
  policyVersion: string;
  approver: Address;
  challengeId: string;
  issuedAt: number;
  expiresAt: number;
};

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Canonical form: sorted keys, integers as strings, addresses lowercased, undefined dropped. */
function canon(v: unknown): unknown {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("binding values must be finite");
    return Number.isInteger(v) ? String(v) : String(v);
  }
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return HEX_ADDRESS.test(v) ? v.toLowerCase() : v;
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

export const canonicalJson = (b: Binding): string => JSON.stringify(canon(b));

export const bindingDigest = (b: Binding): Hex => keccak256(stringToBytes(canonicalJson(b)));

/** The World signal for an approval: bound into the ZK proof as a public input. */
export const approveSignal = (digest: Hex) => `relay-approve:v1:${digest}`;
/** The World signal for linking a World ID to an approver. */
export const enrollSignal = (approver: Address, challengeId: string) => `relay-enroll:v1:${approver.toLowerCase()}:${challengeId}`;

const DECISION_TEXT: Record<Decision, string> = {
  approve: "approve as requested",
  "approve-narrower": "approve a narrower replacement",
  reject: "reject (stays paused)",
  revoke: "revoke the branch (paused permanently)",
};

const iso = (sec: number) => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

export function describeScope(scope: NarrowScope | null | undefined): string {
  if (!scope) return "none";
  const parts: string[] = [];
  if (scope.bundle !== undefined) parts.push(`providers: ${describeBundle(scope.bundle ?? null)}`);
  if (scope.chain) {
    const c = scope.chain;
    const methods = Object.entries(c.methods)
      .map(([k, ms]) => `${k}.${ms.join("/")}`)
      .join(", ");
    parts.push(
      `blockchain: ${c.caps.join(",")} on ${c.net.join(",")}; ${methods || "no write methods"}; to ${(c.to ?? []).join(", ") || "nobody"}; max ${c.max ?? "-"} STD per tx, ${c.limit ?? "-"} STD ${c.period ?? "total"}`,
    );
  } else if (scope.chain === null) parts.push("blockchain: none");
  return parts.join(" | ");
}

/** The exact text the wallet signs. The server rebuilds it; the client can't change it. */
export function approvalMessage(b: Binding, digest: Hex, extra: { subjectLine: string; untilLine?: string | null }): string {
  const lines = [`Relay approval (${b.root})`, extra.subjectLine, `Decision: ${DECISION_TEXT[b.decision]}`];
  if (b.subject.kind === "incident" && (b.decision === "approve" || b.decision === "approve-narrower")) lines.push(`Scope: ${describeScope(b.scope)}`);
  if (b.proposalDigest) lines.push(`Proposal digest: ${b.proposalDigest}`);
  if (extra.untilLine) lines.push(extra.untilLine);
  lines.push(`Approver: ${b.approver.toLowerCase()}`);
  lines.push(`Policy ${b.policyVersion} · Challenge ${b.challengeId} · Expires ${iso(b.expiresAt)}`);
  lines.push(`Digest: ${digest}`);
  return lines.join("\n");
}

export const enrollMessage = (approver: Address, root: string, challengeId: string, expiresAt: number) =>
  `Link World ID to approver ${approver.toLowerCase()} for ${root} (challenge ${challengeId}, expires ${iso(expiresAt)})`;

export const unlinkMessage = (address: Address, challengeId: string) => `Unlink World ID from ${address.toLowerCase()} (challenge ${challengeId})`;

export { chainScopeText, iso };
