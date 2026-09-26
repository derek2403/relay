// Who may decide, and with which factors. Pure.
//
// Factors: incident approve / approve-narrower need the wallet AND a World
// Selfie Check from the approver's linked World ID (they grant authority);
// reject / revoke only take authority away, so the wallet is enough. Chain
// proposals need the wallet only in this build.
//
// Eligible approver: the owner of a human level above the subject. Human
// levels are the member level (the first level whose owner isn't the company
// owner) and every level above it; the levels below it are agents and never
// approve. An address that owns any agent level on the subject's path is
// refused outright (an agent key can't approve its own recovery).

import { type Address, isAddressEqual } from "viem";

import { type GuardLevel, memberLevelIndex } from "../guard";
import type { Decision, Subject } from "./store";

export type Factors = { wallet: true; world: boolean };

export const DECISIONS: Record<Subject["kind"], Decision[]> = {
  incident: ["approve", "approve-narrower", "reject", "revoke"],
  proposal: ["approve", "reject"],
};

export function requiredFactors(subject: Subject["kind"], decision: Decision): Factors {
  return { wallet: true, world: subject === "incident" && (decision === "approve" || decision === "approve-narrower") };
}

/** Why `approver` can't decide for the last level of `levels`, or null when they can. */
export function eligibilityProblem(levels: Pick<GuardLevel, "name" | "owner" | "status">[], approver: Address, rootOwner: Address | null): string | null {
  if (!levels.length) return "the subject can't be read";
  const dead = levels.find((l) => l.status !== "registered");
  if (dead) return `${dead.name} is not registered`;
  const subject = levels.length - 1;
  const member = memberLevelIndex(levels, rootOwner);
  const humanTop = member === -1 ? subject - 1 : Math.min(member, subject - 1);
  const owns = (i: number) => !!levels[i].owner && isAddressEqual(levels[i].owner!, approver);
  for (let i = member === -1 ? levels.length : member + 1; i < levels.length; i++) {
    if (owns(i)) return `${approver} owns ${levels[i].name}, an agent level on this path; agent keys never approve`;
  }
  for (let i = 0; i <= humanTop; i++) if (owns(i)) return null;
  return `${approver} doesn't own a human level above ${levels[subject].name}`;
}

/** True when `levels` (root first) ends in an agent level (below the member level). */
export function isAgentLevel(levels: Pick<GuardLevel, "owner">[], rootOwner: Address | null): boolean {
  const member = memberLevelIndex(levels, rootOwner);
  return member >= 0 && levels.length - 1 > member;
}
