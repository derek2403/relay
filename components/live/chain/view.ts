// Pure view logic for the chain UI: proposal states, timelines, task results and the MultiBaas
// status card. No React; tests/live-chain.test.ts covers it.

import { formatEther } from "viem";

import type { ChainStatus, Finding, PlanStep, Proposal, ProposalState, StepResult, TaskResponse } from "./api";
import { fromBase, shortHex } from "./grant-model";

export const EXPLORER = "https://sepolia.etherscan.io";
export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (address: string) => `${EXPLORER}/address/${address}`;

export const STATE_LABELS: Record<ProposalState, string> = {
  prepared: "Prepared",
  "awaiting-approval": "Awaiting approval",
  approved: "Approved",
  submitting: "Submitting",
  submitted: "Submitted",
  included: "Included",
  confirmed: "Confirmed",
  failed: "Failed",
  uncertain: "Uncertain",
  rejected: "Rejected",
  expired: "Expired",
  blocked: "Blocked",
};

export type Tone = "wait" | "ok" | "bad" | "idle" | "live";

export const stateTone = (s: ProposalState): Tone =>
  s === "confirmed"
    ? "ok"
    : s === "failed" || s === "rejected" || s === "blocked"
      ? "bad"
      : s === "expired"
        ? "idle"
        : s === "awaiting-approval"
          ? "live"
          : "wait";

/** The proposal's current state: `state` if the route sends it, else the last event's. */
export function proposalState(p: Pick<Proposal, "state" | "events">): ProposalState {
  if (p.state) return p.state;
  const last = p.events?.[p.events.length - 1];
  return last?.state ?? "prepared";
}

/** States in which the portal keeps polling (every 4 s). */
export const PENDING_STATES: readonly ProposalState[] = ["prepared", "awaiting-approval", "approved", "submitting", "submitted", "included", "uncertain"];
export const isPending = (s: ProposalState) => PENDING_STATES.includes(s);
/** Past approval: the portal shows the tx side. */
/** Whether the portal should ask for per-level allowance rows: only once the payment is signed and sent (not on approval polls). */
export const wantsAllowance = (s: ProposalState) => ["submitted", "included", "confirmed", "uncertain"].includes(s);
export const isOnChain = (s: ProposalState) => ["submitting", "submitted", "included", "confirmed", "uncertain"].includes(s) || s === "failed";

/** The happy path as a checklist: Requested → Prepared → Awaiting approval → Submitted → Confirmed. */
export function lifecycle(p: Proposal): { label: string; done: boolean; at?: number; detail?: string }[] {
  const seen = new Map<ProposalState, { at: number; detail: string }>();
  for (const e of p.events ?? []) if (!seen.has(e.state)) seen.set(e.state, e);
  const state = proposalState(p);
  const reached = (...states: ProposalState[]) => states.some((s) => seen.has(s) || s === state);
  const needsApproval = p.approval?.required !== false;
  const steps = [
    { label: "Prepared by MultiBaas", done: true, at: p.createdAt },
    ...(needsApproval ? [{ label: "Approved by a human", done: reached("approved", "submitting", "submitted", "included", "confirmed", "uncertain"), at: p.approval?.at ?? seen.get("approved")?.at }] : []),
    { label: "Signed and submitted", done: reached("submitted", "included", "confirmed"), at: p.submit?.at ?? seen.get("submitted")?.at },
    { label: "Included in a block", done: reached("included", "confirmed"), at: seen.get("included")?.at },
    { label: "Confirmed", done: state === "confirmed", at: seen.get("confirmed")?.at },
  ];
  return steps;
}

/** A proposal's amount line: "3 STD → 0x12…abcd" (display fields, else the base-unit amount). */
export function amountText(p: Pick<Proposal, "display" | "amountBase">): string | null {
  const amount = p.display?.amount ?? (p.amountBase ? fromBase(p.amountBase) : null);
  return amount ? `${amount.replace(/\s*STD$/i, "")} STD` : null;
}

/** Hex values (addresses, bytes32) shortened for lists. */
const shortArg = (a: string) => (/^0x[0-9a-f]{20,}$/i.test(a) ? shortHex(a) : a);

/** "(0x12…abcd, 3000…)"; `exact` shows every argument in full (the review dialog). */
export function argsText(args: readonly unknown[] | undefined, exact = false): string {
  if (!args?.length) return "()";
  return `(${args.map((a) => (typeof a === "string" ? (exact ? a : shortArg(a)) : JSON.stringify(a))).join(", ")})`;
}

/** "vault.pay(0x12…, 3000…, 0x…)" */
export const callText = (p: Pick<Proposal, "target" | "method" | "args" | "op">) =>
  p.op === "deploy" ? `deploy ${p.target?.label ?? "escrow"}${argsText(p.args)}` : `${p.target?.label ?? p.target?.kind ?? "contract"}.${p.method}${argsText(p.args)}`;

/** Why a blocked proposal was refused: `{rule, reason}` (null when it wasn't). */
export const blockOf = (p: Pick<Proposal, "block" | "rule" | "reason">) => p.block ?? (p.rule ? { rule: p.rule, reason: p.reason ?? "" } : null);

/** Newest first, with the ones waiting for a human on top. */
export function sortProposals(list: readonly Proposal[]): Proposal[] {
  const rank = (p: Proposal) => (proposalState(p) === "awaiting-approval" ? 0 : isPending(proposalState(p)) ? 1 : 2);
  return [...list].sort((a, b) => rank(a) - rank(b) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/** ETH balance from the status route: wei as a decimal string, or already in ETH. */
export function ethText(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  if (/^\d+$/.test(value) && value.length > 9) return `${Number(formatEther(BigInt(value))).toFixed(4)} ETH`;
  return `${value.replace(/\s*ETH$/i, "")} ETH`;
}

/** STD balance: base units (long integer string) or whole tokens. */
export function stdText(value: string | null | undefined, symbol = "STD"): string {
  if (value === null || value === undefined || value === "") return "—";
  if (/^\d+$/.test(value) && value.length > 12) return `${fromBase(value)} ${symbol}`;
  return `${value} ${symbol}`;
}

export type StatusRow = { label: string; value: string; href?: string; mono?: boolean };

/** The MultiBaas card's rows from GET /api/relay/chain/status. */
export function statusRows(s: ChainStatus | undefined): StatusRow[] {
  if (!s) return [];
  const token = s.token && typeof s.token === "object" ? s.token : s.token ? { address: s.token } : null;
  const rows: StatusRow[] = [
    { label: "Network", value: `${s.network ? s.network[0].toUpperCase() + s.network.slice(1) : "—"}${s.chainId ? ` · ${s.chainId}` : ""}` },
    { label: "Latest block", value: s.block ? s.block.toLocaleString("en-US") : "—", mono: true },
  ];
  if (s.signer) rows.push({ label: "Relay signer", value: `${shortHex(s.signer)} · ${ethText(s.signerBalance)}`, href: addressUrl(s.signer), mono: true });
  if (s.vault?.address) rows.push({ label: "Treasury vault", value: `${shortHex(s.vault.address)} · ${stdText(s.vault.balance ?? null, token?.symbol ?? "STD")}`, href: addressUrl(s.vault.address), mono: true });
  if (token?.address) rows.push({ label: "Token", value: `${token.symbol ?? "STD"} · ${shortHex(token.address)}`, href: addressUrl(token.address), mono: true });
  return rows;
}

export const CHAIN_CAPABILITIES = ["Read", "Track", "Prepare", "Sign & submit", "Deploy", "Manage"] as const;

// --- Task panel ----------------------------------------------------------------------

export const EXAMPLE_TASKS: { label: string; task: string }[] = [
  { label: "Monitor the vault", task: "Review the treasury vault's recent transfers and flag anything unusual." },
  { label: "Pay the supplier", task: "Pay 3 STD to our approved supplier." },
  { label: "Deploy an escrow", task: "Deploy an escrow that pays the supplier 5 STD, funded by the vault, with the vault owner as admin." },
  { label: "Pause the escrow", task: "Check whether our latest escrow is paused, and if not, propose pausing it." },
  { label: "Submit approved", task: "Submit the approved payment." },
];

export type StepView = {
  index: number;
  tool: string;
  target: string;
  args: string;
  why: string;
  outcome: "done" | "blocked" | "error" | "proposed" | "skipped";
  detail: string;
  proposalId?: string;
};

const TOOL_WORDS: Record<string, string> = { read: "Read", events: "Events", tx: "Transaction", prepare: "Prepare", deploy: "Deploy", submit: "Submit", report: "Report" };

function outputText(out: unknown): string {
  if (out === undefined || out === null) return "";
  const text = typeof out === "string" ? out : JSON.stringify(out);
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

/** Each plan step next to what the relay did with it (results are matched by `step`, else by position). */
export function stepViews(res: Pick<TaskResponse, "plan" | "results">): StepView[] {
  const steps: PlanStep[] = res.plan?.steps ?? [];
  const results: StepResult[] = res.results ?? [];
  return steps.map((s, i) => {
    const r = results.find((x) => x.step === i) ?? (results.every((x) => x.step === undefined) ? results[i] : undefined);
    const proposalId = r?.proposalId ?? r?.proposal?.id ?? s.proposalId;
    const blocked = !!r?.rule || (r?.ok === false && !r?.error);
    const outcome: StepView["outcome"] = !r
      ? "skipped"
      : r.error
        ? "error"
        : blocked
          ? "blocked"
          : proposalId && (s.tool === "prepare" || s.tool === "deploy")
            ? "proposed"
            : "done";
    const detail = !r
      ? "Not run."
      : r.error
        ? r.error
        : blocked
          ? `${r.rule ? `${r.rule}: ` : ""}${r.reason ?? "refused"}`
          : proposalId && outcome === "proposed"
            ? `Proposal ${proposalId}`
            : outputText(r.display ?? r.output ?? (r.events ? `${r.events.length} events` : "ok"));
    return {
      index: i + 1,
      tool: TOOL_WORDS[s.tool] ?? s.tool,
      target: [s.contract, s.method].filter(Boolean).join(".") || (s.recipient ? `→ ${s.recipient}` : "—"),
      args: [...(s.args ?? []).map(shortArg), ...(s.amount ? [`${s.amount} STD`] : []), ...(s.recipient && s.contract ? [`to ${shortArg(s.recipient)}`] : [])].join(", "),
      why: s.why,
      outcome,
      detail,
      proposalId,
    };
  });
}

export const findingRuleText = (rule: string) =>
  rule === "large" ? "Large transfer" : rule === "unapproved-recipient" ? "Recipient not approved" : rule;

export function findingRows(findings: readonly Finding[] | undefined) {
  return (findings ?? []).map((f) => ({
    key: `${f.txHash}-${f.rule}`,
    tx: shortHex(f.txHash),
    href: f.explorerUrl ?? txUrl(f.txHash),
    amount: f.amount ? stdText(f.amount) : "—",
    recipient: f.to ? shortHex(f.to) : "—",
    rule: findingRuleText(f.rule),
    why: f.why,
  }));
}

/** Approved proposals a given agent may submit now. */
export const submittable = (list: readonly Proposal[], agentName: string | undefined) =>
  list.filter((p) => p.agent?.name === agentName && proposalState(p) === "approved");

/** "relay chain task "…"" for agents that run from the CLI. */
export const cliTaskCommand = (task: string, as?: string) => `relay chain task ${JSON.stringify(task || "Review the treasury vault's recent transfers")}${as ? ` --as ${as}` : ""}`;
