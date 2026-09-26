// What the portal offers where the relay hides spend and its log: the company owner's wallet
// signs in as the relay admin (components/live/actions/AdminWallet.tsx). Pure: no React, no I/O.

import { type Address, isAddress, isAddressEqual, zeroAddress } from "viem";

import type { StatusResponse } from "@/lib/relay/types";

/**
 * "off" when the relay has no wallet sign-in (viewAuth "open" or "closed", or no RELAY_ROOT_NAME
 * to own), "connect" without a wallet, "not-owner" when the wallet isn't the root's owner (as the
 * tree read it, and RELAY_ROOT_OWNER when pinned), else "ready". An owner not read yet counts as
 * ready: the relay checks the chain before the wallet is asked to sign.
 */
export type AdminWalletState = "off" | "connect" | "not-owner" | "ready";

export function adminWalletState(opts: {
  viewAuth: StatusResponse["viewAuth"];
  /** The relay's RELAY_ROOT_NAME (null when unset, undefined while the status loads). */
  relayRoot?: string | null;
  address: Address | null | undefined;
  /** The root's owner from the tree (zero or undefined while unknown). */
  rootOwner: string | null | undefined;
  /** RELAY_ROOT_OWNER, when the relay pins one. */
  pinnedOwner?: string | null;
  /** A wallet the relay already refused as not the owner. */
  refused?: string | null;
}): AdminWalletState {
  if (opts.viewAuth === "open" || opts.viewAuth === "closed" || opts.relayRoot === null) return "off";
  const { address } = opts;
  if (!address) return "connect";
  const known = (owner: string | null | undefined): owner is Address => !!owner && isAddress(owner, { strict: false }) && owner !== zeroAddress;
  const other = (owner: string | null | undefined) => known(owner) && !isAddressEqual(owner, address);
  const refused = known(opts.refused) && isAddressEqual(opts.refused, address);
  return refused || other(opts.pinnedOwner) || other(opts.rootOwner) ? "not-owner" : "ready";
}

/** Where a sign-in is: waiting for the wallet, the relay checking it, then the hidden reads reloading. */
export type AdminSignInPhase = "sign" | "verify" | "load";
export type AdminSignInShared = { busy: AdminSignInPhase | null; refused: string | null };

export const ADMIN_SIGN_IN_IDLE: AdminSignInShared = { busy: null, refused: null };

/**
 * The sign-in's progress, shared by every prompt on the page (the tree view can show three): one
 * wallet request at a time, and a wallet the relay refused reads "not the owner" everywhere.
 */
export function adminSignInStore() {
  let state = ADMIN_SIGN_IN_IDLE;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<AdminSignInShared>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  return {
    get: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Starts a sign-in; false while one is already running. */
    begin: () => {
      if (state.busy) return false;
      set({ busy: "sign" });
      return true;
    },
    phase: (busy: AdminSignInPhase) => set({ busy }),
    refuse: (address: string) => set({ refused: address }),
    end: () => set({ busy: null }),
  };
}
