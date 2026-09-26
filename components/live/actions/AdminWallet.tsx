"use client";

// Admin sign-in with the company owner's wallet, wherever the relay hides spend and its log:
// challenge → personal_sign → the relay's admin cookie (the same one its token page sets), then
// the relay reads are fetched again so usage bars and the log show up without a reload. Offered
// only to the wallet that owns the root (the relay checks again on-chain); nothing is signed
// until the user clicks.

import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState, useSyncExternalStore } from "react";
import { useSignMessage } from "wagmi";

import { useLive } from "@/components/live/LiveContext";
import { formatError } from "@/lib/ens/errors";
import { ADMIN_SIGN_IN_IDLE, type AdminSignInPhase, type AdminWalletState, adminSignInStore, adminWalletState } from "@/lib/live/admin-sign-in";
import { ADMIN_QUERY_KEYS, ADMIN_SIGN_IN, RelayApiError, adminWalletApi, errorText } from "@/lib/relay/browser";
import { shortAddress } from "@/lib/view-model";

/** One sign-in per page, whichever prompt started it (only click handlers change it, so the server always sees it idle). */
const signInStore = adminSignInStore();
const idle = () => ADMIN_SIGN_IN_IDLE;

export type AdminWallet = {
  state: AdminWalletState;
  busy: AdminSignInPhase | null;
  /** Why this prompt's last sign-in failed (each prompt shows its own). */
  error: string;
  signIn: () => Promise<void>;
};

export function useAdminWallet(): AdminWallet {
  const { address, root, nodes, status, log, toast } = useLive();
  const queryClient = useQueryClient();
  const { mutateAsync: signMessage } = useSignMessage();
  const { busy, refused } = useSyncExternalStore(signInStore.subscribe, signInStore.get, idle);
  const [error, setError] = useState("");
  const rootOwner = nodes.find((node) => node.name === root)?.owner;
  const state = adminWalletState({ viewAuth: status?.viewAuth, relayRoot: status?.root, address, rootOwner, pinnedOwner: status?.rootOwner, refused });

  const signIn = async () => {
    if (!address || !signInStore.begin()) return;
    setError("");
    try {
      const { message } = await adminWalletApi.challenge(address);
      // The account the relay issued the message for: the wallet refuses if it switched meanwhile.
      const signature = await signMessage({ account: address, message });
      signInStore.phase("verify");
      await adminWalletApi.signIn(address, message, signature);
      log("Signed in as admin", `${shortAddress(address)} can see spend and the decision log in this browser.`);
      toast("Signed in as admin.");
      signInStore.phase("load");
      await Promise.all(ADMIN_QUERY_KEYS.map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
    } catch (failure) {
      if (failure instanceof RelayApiError && failure.message === "not the owner") signInStore.refuse(address);
      else setError(failure instanceof RelayApiError ? errorText(failure) : formatError(failure));
    } finally {
      signInStore.end();
    }
  };

  return { state, busy, error, signIn };
}

const BUSY_LABEL: Record<AdminSignInPhase, (what: string) => string> = {
  sign: () => "Confirm the sign-in in your wallet…",
  verify: () => "Checking the owner…",
  load: (what) => `Signed in. Loading ${what}…`,
};

/**
 * How to see `what` (e.g. "spend") where the relay answers "sign in": a button for the root
 * owner's wallet; without a wallet, or with another one, what's missing, with the relay's token
 * page as the fallback. Inline, so it fits in a sentence or a notice.
 */
export function AdminSignInPrompt({ what }: { what: string }) {
  const { root } = useLive();
  const { state, busy, error, signIn } = useAdminWallet();
  const { openConnectModal } = useConnectModal();
  const token = (
    <a href={ADMIN_SIGN_IN} className="agents-link">
      admin token
    </a>
  );

  let body: ReactNode;
  if (state === "off") {
    body = (
      <>
        <a href={ADMIN_SIGN_IN} className="agents-link">
          Sign in as admin
        </a>
        {` to see ${what}.`}
      </>
    );
  } else if (state === "connect") {
    body = (
      <>
        {openConnectModal ? (
          <button type="button" className="agents-link" onClick={openConnectModal}>
            Connect the owner&apos;s wallet
          </button>
        ) : (
          "Connect the owner's wallet"
        )}
        {` to see ${what}, or use the `}
        {token}.
      </>
    );
  } else if (state === "not-owner") {
    body = (
      <>
        {`Only the owner of ${root ?? "the company name"} can see ${what}. Switch to that wallet, or use the `}
        {token}.
      </>
    );
  } else if (busy) {
    body = (
      <button type="button" className="agents-link" disabled>
        {BUSY_LABEL[busy](what)}
      </button>
    );
  } else {
    body = (
      <>
        <button type="button" className="agents-link" onClick={() => void signIn()}>
          Sign in as admin
        </button>
        {` with this wallet to see ${what}.`}
      </>
    );
  }

  return (
    <>
      {body}
      {error && (
        <span className="form-error admin-signin-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
