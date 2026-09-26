"use client";

import type { ReactNode } from "react";
import type { Address } from "viem";

import { Icon } from "@/components/ui/Icon";
import { explorerAddress } from "@/lib/ens/contracts";
import { useLocalJson } from "@/lib/hooks/useLocalJson";
import { plansStorageKey } from "@/lib/relay/browser";

import { plansUnder } from "./logic";

const NO_PLANS: string[] = [];

/** Khaki dialog heading with the close button (.dialog-heading layout from styles/dialogs.css). */
export function DialogHead({ title, onClose, children }: { title: ReactNode; onClose: () => void; children?: ReactNode }) {
  return (
    <>
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button type="button" className="icon-button close-dialog" aria-label="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {children && <p className="dialog-description">{children}</p>}
    </>
  );
}

/** Short address linked to Sepolia Etherscan. */
export function AddressLink({ address }: { address: Address | null | undefined }) {
  if (!address) return <span>—</span>;
  return (
    <a className="live-member-address" href={explorerAddress(address)} target="_blank" rel="noreferrer">
      {address.slice(0, 6)}…{address.slice(-4)}
    </a>
  );
}

/** Plans saved in this browser for `resolver`, limited to names under `parent` (plans can't be listed on-chain). */
export function usePlansUnder(resolver: Address | null | undefined, parent: string): string[] {
  const [plans] = useLocalJson<string[]>(resolver ? plansStorageKey(resolver) : null, NO_PLANS);
  return plansUnder(Array.isArray(plans) ? plans : NO_PLANS, parent);
}
