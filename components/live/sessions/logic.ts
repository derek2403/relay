// Pure rules behind the live session tools (no React, no chain calls), so they can be tested.
// Ported from SRC app/_components/{StartSession,AgentTools,NameActions}.tsx and scripts/relay.ts.

import type { Bundle } from "@/lib/relay/bundle";
import { formatDuration } from "@/lib/relay/browser";

/** Keys of the "Ends after" select: seconds as a string, or "custom" (minutes typed in). */
export type DurationChoice = string;

/** Seconds a session lasts; NaN-safe (0 when the custom minutes aren't a positive number). */
export function durationSeconds(choice: DurationChoice, customMinutes: string): number {
  const n = choice === "custom" ? Math.round(Number(customMinutes) * 60) : Number(choice);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * A new name's expiry: `now + seconds`, never past `cap` (unix seconds).
 * Subagents never outlive their agent (scripts/relay.ts cmdSubagentCreate).
 */
export function sessionExpiry(now: number, seconds: number, cap?: number | null): number {
  const end = now + seconds;
  return cap && cap > 0 ? Math.min(end, cap) : end;
}

/**
 * An access token's expiry: the name's expiry or `maxTtlSec` from now, whichever
 * is first (the relay refuses tokens that live longer than RELAY_MAX_TOKEN_TTL).
 */
export function tokenExpiry(nameExpiry: number, now: number, maxTtlSec: number): number {
  return Math.min(nameExpiry, now + maxTtlSec);
}

/** "24 hours", "90m 00s": how long a token may live at most. */
export const formatTtl = (seconds: number) =>
  seconds % 3600 === 0 ? `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}` : formatDuration(seconds);

/** "Ends in 42m 10s" / "Ended": a session's live countdown. Null until the clock is known (now = 0). */
export function countdown(expiry: number | null, now: number): string | null {
  if (!expiry || !now) return null;
  return expiry > now ? `Ends in ${formatDuration(expiry - now)}` : "Ended";
}

/** What the chain says about the label being created (null fields = not read yet). */
export type LabelRead = {
  registered: boolean;
  /** The label's limits on your resolver were read. */
  bundleRead: boolean;
  hasBundle: boolean;
  /** The label's old record is linked to a plan (relay.plan is set). */
  onPlan: boolean;
  /** The current owner holds ROLE_SET_SUBREGISTRY on the label: a member, not an agent. Undefined = unknown. */
  ownerIsMember: boolean | undefined;
  /** The current owner's key is kept in this browser. */
  ownerKeyHere: boolean;
};

/**
 * A registered label with no limits on your resolver may be your own half-finished session,
 * but only if its owner is an agent (no ROLE_SET_SUBREGISTRY on the name) or a key kept here;
 * a member whose "Add member" stopped after step 1 must not get agent-style limits.
 */
export function isResumable(r: LabelRead): boolean {
  return r.registered && r.bundleRead && !r.hasBundle && (r.ownerIsMember === false || r.ownerKeyHere);
}

export type SessionPath = "one-tx" | "two-tx";

/**
 * One transaction through the SessionMinter when it is ready for this registry + resolver and
 * the label is new. The minter only writes setText/setAddress and can't detach a name from a
 * plan's shared record, so it is used only once the read shows the old record isn't on a plan.
 * A registry that still has to be set up (subagents) always takes the step-by-step path.
 */
export function sessionPath(opts: { minterReady: boolean; registryLive: boolean; registered: boolean; bundleRead: boolean; onPlan: boolean }): SessionPath {
  return opts.minterReady && opts.registryLive && !opts.registered && opts.bundleRead && !opts.onPlan ? "one-tx" : "two-tx";
}

/** Label typed in the dialog: one normalized label, not reserved. */
export function sessionLabel(normalized: string | null, reserved: readonly string[] = []): string | null {
  if (!normalized || normalized.includes(".")) return null;
  return reserved.includes(normalized) ? null : normalized;
}

/** Why "Start" is disabled, or null. Mirrors SRC StartSession's `problem`, in the same order. */
export function sessionProblem(o: {
  labelInput: string;
  label: string | null;
  reserved: boolean;
  childName: string | null;
  checking: boolean;
  registered: boolean;
  readFailed: boolean;
  resumable: boolean;
  seconds: number;
  pasteMode: boolean;
  pastedOk: boolean;
  pasted: string;
  bundleError: string | null;
}): string | null {
  if (!o.label) {
    if (o.reserved) return "That label is reserved. Pick another.";
    return o.labelInput ? 'Use one simple label, like "laptop".' : null;
  }
  if (o.checking) return null;
  if (o.registered && o.readFailed) return `Couldn't read the limits of ${o.childName}. Refresh and try again.`;
  if (o.registered && !o.resumable) return `${o.childName} is already taken.`;
  if (!(o.seconds > 0)) return "Pick how long.";
  if (o.pasteMode && !o.registered && !o.pastedOk) return o.pasted ? "That isn't an address." : null;
  return o.bundleError;
}

// --- Subagents -------------------------------------------------------------------------------

export type SubagentGateInput = {
  /** The agent's name is live (registered, not expired). */
  active: boolean;
  /** A registry is attached under the agent (its subregistry), or null. */
  subregistry: string | null;
  /** The registry this wallet would deploy for the agent (VerifiableFactory prediction). */
  predicted: string | null;
  /** Wallet holds ROLE_REGISTRAR on the attached registry. */
  canRegisterBelow: boolean;
  /** Wallet may setSubregistry on the agent's token in the registry holding it (token or root roles). */
  canSetSubregistry: boolean;
  /** Role reads still in flight. */
  loading: boolean;
};

export type SubagentGate =
  | { mode: "loading" }
  | { mode: "ready"; registry: string }
  | { mode: "setup"; registry: string }
  | { mode: "blocked"; reason: string };

const eq = (a: string | null, b: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Whether this wallet can create a subagent under an agent, and how.
 * - ready: a registry is attached and the wallet may register in it.
 * - setup: the wallet first deploys (or finishes) its own registry for the agent,
 *   attaches it (setSubregistry) and points it back (setParent) — SRC SubnameSetup's steps.
 * - blocked: say why; the dialog shows the ./relay alternative.
 */
export function subagentGate(g: SubagentGateInput, agentName: string): SubagentGate {
  if (!g.active) return { mode: "blocked", reason: `${agentName} isn't live, so it can't get subagents.` };
  if (g.loading) return { mode: "loading" };
  if (g.subregistry) {
    // Our own registry, attached earlier: finishing its setup (setParent) is part of the flow.
    if (eq(g.subregistry, g.predicted)) return g.canRegisterBelow ? { mode: "setup", registry: g.subregistry } : { mode: "blocked", reason: `This wallet can't add names under ${agentName}.` };
    if (g.canRegisterBelow) return { mode: "ready", registry: g.subregistry };
    return { mode: "blocked", reason: `Subagents of ${agentName} are managed by the key that set them up (usually ./relay on the user's laptop).` };
  }
  if (!g.canSetSubregistry) return { mode: "blocked", reason: `This wallet can't attach a registry under ${agentName}. It needs the set-subregistry role in the registry that holds it.` };
  if (!g.predicted) return { mode: "loading" };
  return { mode: "setup", registry: g.predicted };
}

/** Labels a subagent can't take (scripts/relay.ts subagentLabel). */
export const reservedSubagentLabels = (agentName: string) => ["agent", agentName.split(".")[0]];

/** The ./relay command that creates the same subagent from the agent's machine. */
export function subagentCommand(label: string | null, bundle: Bundle | null, seconds: number): string {
  const parts = ["./relay subagent create", label || "research"];
  const codex = bundle?.keys.includes("codex") ? bundle.caps.codex : undefined;
  const images = bundle?.keys.includes("openai-images") ? bundle.maxes?.["openai-images"] : undefined;
  if (codex !== undefined) parts.push(`--codex ${codex}`);
  if (images !== undefined) parts.push(`--images ${images}`);
  if (seconds > 0) parts.push(`--minutes ${Math.max(1, Math.round(seconds / 60))}`);
  return parts.join(" ");
}

/**
 * ETH to send the agent key before it sets its primary name: double what's missing,
 * at least `min`, so a retry doesn't need another top-up (SRC AgentTools PrimaryName).
 */
export function topUpAmount(need: bigint, balance: bigint, min: bigint): bigint {
  const missing = need * 2n - balance;
  return missing > min ? missing : min;
}
