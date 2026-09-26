// Pure decisions behind the live member actions (SRC NameActions / AddMember / ManageChild / SubnameSetup).
// No React, no wagmi: tests/live-members.test.ts covers them.

import { tryNormalize } from "@/lib/ens/names";
import { type BundleDraft, type LevelBundle, isNever, limitsAbove } from "@/lib/relay/browser";
import type { Period } from "@/lib/relay/bundle";
import type { ProviderId } from "@/lib/relay/catalog";
import type { FundResponse } from "@/lib/relay/types";

/** The useRelayNode flags the gates read (a subset, so tests can build them by hand). */
export type GateFlags = {
  connected: boolean;
  isRoot: boolean;
  kind: "company" | "member" | "agent" | null;
  active: boolean;
  expired: boolean;
  iOwn: boolean;
  subregistry: string | null;
  expiry: number | null;
  canAddBelow: boolean;
  canRemove: boolean;
  canRenew: boolean;
  canWriteBundle: boolean;
  canLink: boolean;
  delegatedCaps: readonly string[];
};

export type Gates = {
  /** "Add a member": the wallet owns the name and may register in its registry. */
  add: boolean;
  /** "Let me add names below": an active non-root name of this wallet without its own registry. */
  enableBelow: boolean;
  /** Names below were set up by another wallet. */
  registryNotMine: boolean;
  /** The root still needs company setup before people can be added. */
  needsCompanySetup: boolean;
  /** SRC `manages`: the level above (or a cap delegate) may change this name. */
  manages: boolean;
  editLimits: boolean;
  changeCap: boolean;
  usePlan: boolean;
  extend: boolean;
  /** "Bring back" instead of "Extend" (the name has ended). */
  revive: boolean;
  remove: boolean;
  /** Removed by the level above (not just ended). */
  removed: boolean;
  /** Ended, and this wallet can't renew it. */
  endedForGood: boolean;
  /** Connected, but no action applies to this wallet. */
  nothingToDo: boolean;
};

/** Which member actions the connected wallet gets for a name, exactly as SRC NameActions/ManageChild gate them. */
export function memberGates(n: GateFlags): Gates {
  const add = n.iOwn && !!n.subregistry && n.canAddBelow;
  const enableBelow = n.iOwn && !n.isRoot && !n.subregistry && n.active;
  const registryNotMine = n.iOwn && !!n.subregistry && !n.canAddBelow;
  const needsCompanySetup = n.iOwn && n.isRoot && !n.subregistry;
  const removed = !n.isRoot && !n.active && !n.expired;
  const hasCaps = n.delegatedCaps.length > 0;
  const manages =
    (!n.isRoot && (n.active || n.expired) && (n.canRemove || n.canRenew || n.canWriteBundle || hasCaps)) ||
    // A cap delegated on the company owner's resolver also covers the company-wide limit.
    (n.isRoot && n.active && !n.canWriteBundle && hasCaps);
  const editLimits = manages && n.canWriteBundle && n.active;
  const changeCap = manages && !n.canWriteBundle && hasCaps && n.active;
  const usePlan = manages && n.kind === "member" && n.canLink && n.active;
  const extend = manages && n.canRenew && (n.active || n.expired) && !isNever(n.expiry ?? 0);
  const remove = manages && n.canRemove && n.active;
  const endedForGood = n.expired && !n.canRenew;
  const nothingToDo = n.connected && !removed && !n.expired && !add && !enableBelow && !registryNotMine && !manages && !n.isRoot;
  return {
    add,
    enableBelow,
    registryNotMine,
    needsCompanySetup,
    manages,
    editLimits,
    changeCap,
    usePlan,
    extend,
    revive: extend && n.expired,
    remove,
    removed,
    endedForGood,
    nothingToDo,
  };
}

/** A single normalized ENS label ("Derek" → "derek"), or null for empty/invalid/dotted input. */
export function memberLabel(input: string): string | null {
  const normalized = tryNormalize(input.trim());
  return normalized && !normalized.includes(".") ? normalized : null;
}

/** Seconds for the duration select: a MEMBER_DURATIONS value, or "custom" with a day count. */
export function durationSeconds(duration: string, customDays: string): number {
  return duration === "custom" ? Math.round(Number(customDays) * 86400) : Number(duration);
}

/** New expiry for Extend / Bring back: counted from now for an ended name, from its expiry otherwise. */
export const extendedExpiry = (now: number, expiry: number | null, by: number) => Math.max(now, expiry ?? 0) + by;

export type LabelBadge = "free" | "registered" | "taken";

/** Live badge next to the label: taken = registered to someone other than the typed owner. */
export function labelBadge(registered: boolean, takenByOther: boolean): LabelBadge {
  return takenByOther ? "taken" : registered ? "registered" : "free";
}

/** The first thing wrong with the add-member form (SRC AddMember order), or null. Empty inputs stay quiet. */
export function addProblem(f: {
  labelInput: string;
  label: string | null;
  ownerInput: string;
  owner: string | null;
  seconds: number;
  takenByOther: boolean;
  childName: string | null;
  plan: string;
  bundleError: string | null;
  planMissing: boolean;
}): string | null {
  if (!f.label) return f.labelInput.trim() ? 'Use one simple label, like "derek".' : null;
  if (!f.owner) return f.ownerInput.trim() ? "That isn't a wallet address." : null;
  if (!(f.seconds > 0)) return "Pick how long.";
  if (f.takenByOther) return `${f.childName} is already taken.`;
  if (!f.plan && f.bundleError) return f.bundleError;
  if (f.planMissing) return "That plan has no limits written yet. Save it in Policies first.";
  return null;
}

/** One API a preset ticks: `name` for the button, `cap` in dollars, `max` in requests or images (left out = none). */
export type PresetApi = { id: ProviderId; name: string; cap?: number; max?: number };
export type MemberPreset = { apis: readonly PresetApi[]; period: Period };

/**
 * The member the admin usually adds, one click in "Add a member": these APIs ticked, every other
 * one unticked, the blockchain grant back to the form's default. Label, wallet and duration stay.
 */
export const MEMBER_PRESET: MemberPreset = {
  apis: [
    { id: "codex", name: "Codex", cap: 2 },
    { id: "openai-images", name: "Images", max: 3 },
    { id: "weather", name: "Weather", max: 20 },
    { id: "multibaas", name: "MultiBaas" },
  ],
  period: "month",
};

/**
 * The API form a preset fills in. APIs a level above blocks are skipped, and caps or limits over
 * theirs come down to theirs. `above` as levelsAbove returns it (undefined = nothing above limits
 * it). Null while the levels above load, or when they allow none of the preset's APIs.
 */
export function presetDraft(preset: MemberPreset, above: LevelBundle[] | null | undefined): BundleDraft | null {
  if (above === null) return null;
  const draft: BundleDraft = { keys: [], caps: {}, maxes: {}, period: preset.period };
  for (const api of preset.apis) {
    const lim = above ? limitsAbove(above, api.id) : null;
    if (lim?.blockedBy) continue;
    draft.keys.push(api.id);
    if (api.cap !== undefined) draft.caps[api.id] = String(Math.min(api.cap, lim?.cap?.value ?? Infinity));
    if (api.max !== undefined) draft.maxes[api.id] = String(Math.min(api.max, lim?.max?.value ?? Infinity));
  }
  return draft.keys.length ? draft : null;
}

/**
 * "Codex $2 · Images 3 · Weather 20 · MultiBaas": what presetDraft ticked, with its limits. No-break
 * spaces keep each API next to its number, so a narrow button wraps between APIs.
 */
export const presetLabel = (preset: MemberPreset, draft: BundleDraft) =>
  preset.apis
    .filter((a) => draft.keys.includes(a.id))
    .map((a) => [a.name, draft.caps[a.id] && `$${draft.caps[a.id]}`, draft.maxes[a.id]].filter(Boolean).join(" "))
    .join(" · ");

/** Plans created in this browser for names under `parent` (plan-<slug>.<parent>). */
export const plansUnder = (plans: readonly string[], parent: string) => plans.filter((p) => p.endsWith(`.${parent}`));

/** "plan-interns.acme.eth" → "interns". */
export const planLabel = (plan: string) => plan.split(".")[0].replace(/^plan-/, "");

/** An empty cap clears it; otherwise a non-negative dollar amount. */
export const capValid = (v: string) => v.trim() === "" || (Number.isFinite(Number(v)) && Number(v) >= 0);

/**
 * Saving limits on a name that shares a plan's record would edit the plan, so it needs a detach
 * (ROLE_LINK, plus ROLE_SET_ADDRESS for an agent whose address is rewritten into the fresh record).
 */
export function editRules(f: { canLink: boolean; canSetAddress: boolean; kind: GateFlags["kind"]; readOk: boolean; linkedPlan: string | null }) {
  const canDetach = f.canLink && (f.kind !== "agent" || f.canSetAddress);
  const stuckOnPlan = !canDetach && (!f.readOk || !!f.linkedPlan);
  return { canDetach, stuckOnPlan };
}

export type SetupStep = { key: "resolver" | "registry" | "attach" | "parent"; label: string; done: boolean };

/** SubnameSetup checklist in plain words: deploy resolver, deploy registry, setSubregistry, setParent. */
export function subnameSteps(
  name: string,
  s: { withResolver: boolean; resolverDeployed: boolean; deployed: boolean; attached: boolean; parentOk: boolean },
): SetupStep[] {
  return [
    ...(s.withResolver ? [{ key: "resolver" as const, label: "Your resolver (holds the limits of names you add)", done: s.resolverDeployed }] : []),
    { key: "registry", label: `Create a place for names under ${name}`, done: s.deployed },
    { key: "attach", label: `Connect it to ${name}`, done: s.attached },
    { key: "parent", label: `Confirm it belongs to ${name} (so the relay trusts it)`, done: s.parentOk },
  ];
}

/** The first step not done yet (the one to highlight), or -1. */
export const activeStep = (steps: readonly { done: boolean }[]) => steps.findIndex((s) => !s.done);

export type Fund = { status: "sending" } | { status: "done"; result: FundResponse } | { status: "error"; message: string };

/** One line about the gas top-up after adding a member. */
export function fundText(fund: Fund | null): string | null {
  if (!fund) return null;
  if (fund.status === "sending") return "Sending them Sepolia ETH for gas…";
  if (fund.status === "error") return `No Sepolia ETH sent: ${fund.message}`;
  const r = fund.result;
  return r.funded ? `Sent ${r.amountEth} Sepolia ETH to ${r.address} for gas.` : `No Sepolia ETH sent: ${r.reason}`;
}

export const shortAddress = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
