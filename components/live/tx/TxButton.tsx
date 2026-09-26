"use client";

import type { ReactNode } from "react";
import { useConnection } from "wagmi";

import type { Tx } from "@/lib/hooks/useTx";
import { CHAIN_ID } from "@/lib/wagmi";

import { TX_VARIANT_CLASS, type TxVariant, txBlockReason, txBusyLabel } from "./txView";

export type TxButtonProps = {
  /** The tx this button runs; every TxButton sharing one tx disables while it is busy. */
  tx: Tx;
  /** Starts the write, usually `() => tx.run(() => writeContract(...))` or a multi-step flow. */
  onClick: () => unknown;
  disabled?: boolean;
  /**
   * Visual style from the khaki classes: detail-button (default), primary, secondary,
   * danger (revoke-button, the quiet text link in the detail panel), danger-solid (the filled `.danger` dialog confirm).
   */
  variant?: TxVariant;
  /** Tooltip when enabled; replaced by the reason while disabled for wallet/chain/busy. */
  title?: string;
  /** Extra classes (e.g. an id-like hook for styling). */
  className?: string;
  children: ReactNode;
};

/** Disabled with a reason (tooltip) when there is no wallet, the wrong chain, or the tx is busy; label changes while signing/pending. */
export function TxButton({ tx, onClick, disabled, variant = "detail", title, className, children }: TxButtonProps) {
  const { isConnected, chainId } = useConnection();
  const reason = txBlockReason({ isConnected, chainId, targetChainId: CHAIN_ID, busy: tx.busy });
  const busyLabel = txBusyLabel(tx.state.status);
  return (
    <button
      type="button"
      className={[TX_VARIANT_CLASS[variant], "tx-button", className].filter(Boolean).join(" ")}
      disabled={Boolean(disabled) || reason !== null}
      aria-busy={tx.busy || undefined}
      title={reason ?? title}
      onClick={() => void onClick()}
    >
      {busyLabel ?? children}
    </button>
  );
}
