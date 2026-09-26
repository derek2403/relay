"use client";

// Owner sign-in for credential editing: nonce → wallet personal_sign → HttpOnly session cookie.
// Only the wallet that owns the company root on ENS gets a session; the relay says why otherwise.

import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useState } from "react";
import { useSignMessage } from "wagmi";
import { useLive } from "@/components/live/LiveContext";
import { formatError } from "@/lib/ens/errors";
import { RelayApiError } from "@/lib/relay/browser";
import { apiErrorText, credentialsApi, type CredentialsResponse } from "./api";
import { formatUpdated, messageFor, shortAddress } from "./logic";

export type OwnerAuth = {
  busy: "sign" | "verify" | "out" | null;
  error: string;
  signIn: () => Promise<boolean>;
  signOut: () => Promise<void>;
  clearError: () => void;
};

const failureText = (error: unknown) => (error instanceof RelayApiError ? apiErrorText(error) : formatError(error));

/** Sign-in state shared by the owner bar and the edit dialogs. `reload` re-reads the credentials. */
export function useOwnerAuth(reload: () => Promise<unknown>): OwnerAuth {
  const { address, log, toast } = useLive();
  const { mutateAsync: signMessage } = useSignMessage();
  const { openConnectModal } = useConnectModal();
  const [busy, setBusy] = useState<OwnerAuth["busy"]>(null);
  const [error, setError] = useState("");

  const signIn = async () => {
    setError("");
    if (!address) {
      if (openConnectModal) openConnectModal();
      else setError("Connect a wallet first.");
      return false;
    }
    try {
      setBusy("sign");
      const { message } = await credentialsApi.nonce(address);
      const text = messageFor(message, address);
      const signature = await signMessage({ message: text });
      setBusy("verify");
      const { owner } = await credentialsApi.signIn(address, text, signature);
      await reload();
      if (!owner) throw new Error("The relay did not start a session.");
      log("Owner signed in", `${shortAddress(owner.address)} can edit relay credentials.`);
      toast("Signed in as owner.");
      return true;
    } catch (failure) {
      setError(failureText(failure));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const signOut = async () => {
    setError("");
    try {
      setBusy("out");
      await credentialsApi.signOut();
      await reload();
      toast("Signed out.");
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy(null);
    }
  };

  return { busy, error, signIn, signOut, clearError: () => setError("") };
}

export function signInLabel(auth: OwnerAuth, connected: boolean) {
  if (auth.busy === "sign") return "Confirm in your wallet…";
  if (auth.busy === "verify") return "Checking owner…";
  return connected ? "Sign in as owner" : "Connect wallet";
}

/** Who may edit credentials right now, with sign in / sign out. */
export function OwnerBar({ creds, auth }: { creds: CredentialsResponse | undefined; auth: OwnerAuth }) {
  const live = useLive();
  const address = live.address;
  if (!creds) return null;
  const root = creds.root ?? live.root;

  let body;
  if (creds.owner) {
    const other = address && address.toLowerCase() !== creds.owner.address.toLowerCase();
    body = (
      <>
        <p>
          Signed in as <b className="lp-mono">{shortAddress(creds.owner.address)}</b>
          {root ? `, owner of ${root}` : ""}. Session ends {formatUpdated(creds.owner.expiresAt)}.
          {other ? " The connected wallet is a different one." : ""}
        </p>
        <button type="button" className="secondary" disabled={!!auth.busy} onClick={() => void auth.signOut()}>
          {auth.busy === "out" ? "Signing out…" : "Sign out"}
        </button>
      </>
    );
  } else if (creds.admin) {
    body = <p>Signed in with the relay admin token. You can edit credentials.</p>;
  } else {
    body = (
      <>
        <p>
          Sign in as the owner{root ? ` of ${root}` : ""} to see redacted keys and edit them. Only the wallet that owns the company
          root can.
        </p>
        <button type="button" className="primary" disabled={!!auth.busy || !creds.secretConfigured} onClick={() => void auth.signIn()}>
          {signInLabel(auth, !!address)}
        </button>
      </>
    );
  }

  return (
    <div className="lp-owner">
      <div className="lp-owner-row">{body}</div>
      {!creds.secretConfigured && (
        <div className="form-hint">
          Credential editing is off. Set <code>RELAY_SECRET</code> on the relay (for example <code>openssl rand -hex 32</code>) and
          restart it.
        </div>
      )}
      {creds.storeError && (
        <p className="form-error" role="alert">
          Stored credentials can't be read: {creds.storeError}
        </p>
      )}
      {auth.error && (
        <p className="form-error" role="alert">
          {auth.error}
        </p>
      )}
    </div>
  );
}
