// Pure helpers for the live Setup view (no React, no browser APIs), so they can be unit tested.

import { tryNormalize } from "@/lib/ens/names";
import { type FunderStatus, envTemplate } from "@/lib/relay/browser";
import { type Bundle, PROVIDERS } from "@/lib/relay/bundle";
import { isListed } from "@/lib/relay/catalog";
import type { StatusResponse } from "@/lib/relay/types";

// --- Relay status -------------------------------------------------------------------

export const DRAFT_ROOT_PROBLEM = "The company name must be a .eth name, like yourcompany.eth.";

/** The draft root typed in this browser, when it is a usable company root (a .eth second-level name). */
export function draftRootOf(raw: string): string | null {
  const name = tryNormalize(raw.trim());
  return name && /^[^.]+\.eth$/.test(name) ? name : null;
}

/** Why the typed draft can't be used, or null (empty input is not a problem yet). */
export const draftRootProblem = (raw: string): string | null => (raw.trim() && !draftRootOf(raw) ? DRAFT_ROOT_PROBLEM : null);

/** The .env.local lines for a relay that doesn't know its root yet. */
export const setupEnvTemplate = (draft: string) => envTemplate(draftRootOf(draft) ?? "yourcompany.eth");

/** Catalog APIs the relay holds a key for, and the rest (still delegable; calls refused until a key is set). */
export function providerSplit(status: StatusResponse | undefined) {
  const providers = (status?.providers ?? []).filter((p) => isListed(p.id));
  return { withKey: providers.filter((p) => p.configured), noKey: providers.filter((p) => !p.configured) };
}

/** "12 h", "30 min", "2 d" for the token lifetime cap. */
export function formatTtl(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

export type AdminState = "open" | "closed" | "signed-in" | "signed-out" | "unknown";

/**
 * Who may read spend and the log from this browser. With viewAuth "token" a same-origin
 * GET /api/relay/log only succeeds with the admin cookie (agent tokens are never sent by the page).
 */
export function adminState(viewAuth: StatusResponse["viewAuth"], log: { ok: boolean; status: number | null }): AdminState {
  if (viewAuth === "open") return "open";
  if (viewAuth === "closed") return "closed";
  if (viewAuth !== "token") return "unknown";
  if (log.ok) return "signed-in";
  return log.status === 401 ? "signed-out" : "unknown";
}

// --- Company setup ------------------------------------------------------------------

/** Starting point for the company bundle: every catalog API the relay has a key for (SRC CompanySetup). */
export function companyDefault(status: StatusResponse | undefined): Bundle {
  const keys = PROVIDERS.filter((p) => isListed(p.id) && status?.providers.find((s) => s.id === p.id)?.configured).map((p) => p.id);
  const caps = Object.fromEntries(PROVIDERS.filter((p) => p.metered && keys.includes(p.id)).map((p) => [p.id, 100]));
  return { keys, caps, maxes: {}, period: "month" };
}

export type CompanyChain = {
  owns: boolean;
  resolverDeployed: boolean;
  pointed: boolean;
  hasLimits: boolean;
  editingLimits: boolean;
  subnamesDone: boolean;
};

export type CompanyStepId = "own" | "resolver" | "point" | "limits" | "subnames";
export type CompanyStep = { id: CompanyStepId; done: boolean; active: boolean };

/** The five checklist ticks, read from chain state; a step is active once its prerequisites are met. */
export function companySteps(c: CompanyChain): CompanyStep[] {
  return [
    { id: "own", done: c.owns, active: true },
    { id: "resolver", done: c.resolverDeployed, active: c.owns },
    { id: "point", done: c.pointed, active: c.owns && c.resolverDeployed },
    { id: "limits", done: c.hasLimits && !c.editingLimits, active: c.pointed },
    { id: "subnames", done: c.subnamesDone, active: c.owns },
  ];
}

/** Every step done: the relay can serve the company. */
export const companyReady = (c: CompanyChain) => c.owns && c.resolverDeployed && c.pointed && c.hasLimits && c.subnamesDone;

/** The first step still open, or null when all are done. */
export const currentCompanyStep = (steps: readonly CompanyStep[]): CompanyStepId | null => steps.find((s) => !s.done)?.id ?? null;

// --- Registering the root (commit-reveal) -----------------------------------------

/** ETHRegistrar.MIN_COMMITMENT_AGE on Sepolia is 60 s; a few extra seconds absorb clock skew. */
export const COMMIT_WAIT = 60 + 5;
export const YEAR = 365n * 24n * 60n * 60n;

/** Seconds left before `register` may be sent; null while the clock or the commitment time is unknown. */
export function commitWaitLeft(commitTime: number, now: number): number | null {
  if (!commitTime || !now) return null;
  return Math.max(0, commitTime + COMMIT_WAIT - now);
}

/** 1% headroom over the quoted price: it comes from an oracle and can move by rounding. */
export const approveAmount = (total: bigint) => (total * 101n) / 100n;

export const needsApproval = (total: bigint | undefined, allowance: bigint | undefined) => total !== undefined && (allowance ?? 0n) < total;

export type RegisterStep = 0 | 1 | 2 | 3 | 4;
export const REGISTER_STEPS = ["Deploy your resolver", "Approve USDC spending", "Commit", "Wait about a minute", "Register"] as const;

/** Which register step is current: resolver, approve, commit, wait, register (SRC RegisterCard). */
export function registerStep(s: { resolverDeployed: boolean; needsApproval: boolean; commitTime: number; waitLeft: number | null }): RegisterStep {
  if (!s.resolverDeployed) return 0;
  if (s.needsApproval) return 1;
  if (!s.commitTime) return 2;
  return s.waitLeft !== 0 ? 3 : 4;
}

/** A single .eth label from what the user typed ("acme" or "acme.eth"), or null. */
export function registerLabel(input: string): string | null {
  const normalized = tryNormalize(input.replace(/\.eth$/, ""));
  return normalized && !normalized.includes(".") ? normalized : null;
}

/** localStorage key of the saved commitment secret (same as SRC, so a commit made there resumes here). */
export const commitStorageKey = (address: string, label: string) => `ensv2:commit:${address}:${label}`;

// --- Gas funder ---------------------------------------------------------------------

export function funderSummary(funder: FunderStatus | null): { on: boolean; text: string } {
  if (!funder) return { on: false, text: "This relay doesn't report a gas funder." };
  if (funder.enabled) return { on: true, text: `On. New members get ${funder.amountEth} Sepolia ETH for gas.` };
  return { on: false, text: funder.error ?? "Off. New members get no gas (set FUNDER_PRIVATE_KEY)." };
}

// --- Scripts ------------------------------------------------------------------------

/** What POST /api/relay/admin/reset answers (lib/relay/reset.ts ResetResult; a server module, so not imported here). */
export type ResetResult = { cleared: string[]; keys: number; logEntries: number; skipped: { name: string; reason: string }[] };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function resetSummary(r: ResetResult): string {
  const parts = [plural(r.cleared.length, "name"), plural(r.keys, "spend entry", "spend entries"), plural(r.logEntries, "log entry", "log entries")];
  const skipped = r.skipped.length ? ` ${plural(r.skipped.length, "name")} skipped.` : "";
  return `Cleared ${parts.join(" · ")}.${skipped}`;
}

export type ScriptCommand = { command: string; title: string; what: string; env: string };

export const SCRIPT_COMMANDS: readonly ScriptCommand[] = [
  {
    command: "npm run org:seed",
    title: "Build the company",
    what: "Registers <org>.eth and every department, team, member, agent and subagent in org/<org>.json. Every level gets its own registry and limits. Safe to re-run: finished steps are skipped.",
    env: "ADMIN_PRIVATE_KEY, ORG_LABEL (else RELAY_ROOT_NAME)",
  },
  {
    command: "npm run demo:reset",
    title: "Remove added names",
    what: "Removes every name added under the teams, asks the relay to clear spend for names that no longer exist, and deletes the local CLI keys. The company, departments and teams stay.",
    env: "ADMIN_PRIVATE_KEY, ORG_LABEL, RELAY_ADMIN_TOKEN, RELAY_URL · flags --yes, --keep-home",
  },
];
