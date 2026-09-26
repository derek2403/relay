// Pure view logic for TxButton / TxStatus (SRC components/Tx.tsx), kept free of React for tests.

import type { Hex } from "viem";
import type { TxState } from "@/lib/hooks/useTx";

export type TxVariant = "detail" | "primary" | "secondary" | "danger" | "danger-solid";

/** Khaki class per variant: detail-button, primary, secondary, revoke-button, danger (solid, for dialog confirms). */
export const TX_VARIANT_CLASS: Record<TxVariant, string> = {
  detail: "detail-button",
  primary: "primary",
  secondary: "secondary",
  danger: "revoke-button",
  "danger-solid": "danger",
};

/** Why a write can't start yet, or null. Busy wins so the tooltip matches the label. */
export function txBlockReason(opts: { isConnected: boolean; chainId: number | undefined; targetChainId: number; busy: boolean }): string | null {
  if (!opts.isConnected) return "Connect a wallet first.";
  if (opts.chainId !== opts.targetChainId) return "Switch to Sepolia.";
  if (opts.busy) return "Another transaction is in progress.";
  return null;
}

/** Replacement label while the tx runs, or null to keep the button's own label. */
export function txBusyLabel(status: TxState["status"]): string | null {
  if (status === "signing") return "Confirm in wallet…";
  if (status === "pending") return "Waiting…";
  return null;
}

export type TxTone = "info" | "ok" | "bad";

export type TxStatusView = {
  badge: string;
  tone: TxTone;
  hash: Hex | null;
  /** "block N · gas G" once mined. */
  receipt: string | null;
  error: string | null;
};

const BADGES: Record<Exclude<TxState["status"], "idle">, [string, TxTone]> = {
  signing: ["Awaiting signature", "info"],
  pending: ["Pending", "info"],
  success: ["Confirmed", "ok"],
  reverted: ["Reverted", "bad"],
  error: ["Failed", "bad"],
};

export function txStatusView(s: TxState): TxStatusView | null {
  if (s.status === "idle") return null;
  const [badge, tone] = BADGES[s.status];
  const mined = s.status === "success" || s.status === "reverted";
  return {
    badge,
    tone,
    hash: "hash" in s && s.hash ? s.hash : null,
    receipt: mined ? `block ${s.receipt.blockNumber.toString()} · gas ${s.receipt.gasUsed.toString()}` : null,
    error: s.status === "error" ? s.error : null,
  };
}

export const shortHash = (hash: string) => `${hash.slice(0, 10)}…${hash.slice(-8)}`;

/** Index of the step to highlight: the first one not done and not blocked (`active: false`); -1 when none. */
export function currentStep(steps: readonly { done: boolean; active?: boolean }[]): number {
  return steps.findIndex((s) => !s.done && s.active !== false);
}
