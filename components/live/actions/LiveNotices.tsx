"use client";

import { useState, type ReactNode } from "react";
import { tryNormalize } from "@/lib/ens/names";
import { ADMIN_SIGN_IN, errorText } from "@/lib/relay/browser";
import { AdminSignInPrompt } from "./AdminWallet";

/** A khaki notice box: a title, a sentence or two, and optional controls. */
export function LiveNotice({ title, children, tone = "info" }: { title: string; children?: ReactNode; tone?: "info" | "warning" }) {
  return (
    <div className={`live-notice ${tone}`} role={tone === "warning" ? "alert" : "status"}>
      <strong>{title}</strong>
      {children}
    </div>
  );
}

/** True for a company root the relay can use: a normalized second-level .eth name. */
export const isRootName = (name: string | null): name is string => !!name && /^[^.]+\.eth$/.test(name);

/** Company name typed in this browser (SRC StatusLine): used while the relay has no RELAY_ROOT_NAME. */
export function DraftRootField({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  const [text, setText] = useState(value);
  const normalized = tryNormalize(text.trim());
  const problem = text.trim() && !isRootName(normalized) ? "The company name must be a .eth name, like yourcompany.eth." : null;
  return (
    <form
      className="live-draft-root"
      onSubmit={(event) => {
        event.preventDefault();
        if (normalized && isRootName(normalized)) onChange(normalized);
      }}
    >
      <label htmlFor="liveDraftRoot">Company name</label>
      <div className="form-row">
        <input id="liveDraftRoot" value={text} placeholder="yourcompany.eth" autoComplete="off" spellCheck={false} onChange={(event) => setText(event.target.value)} />
        <button type="submit" className="secondary" disabled={!normalized || !isRootName(normalized) || normalized === value}>
          Use this name
        </button>
      </div>
      {problem ? <p className="form-error">{problem}</p> : <p className="form-hint">Saved in this browser. The relay&apos;s RELAY_ROOT_NAME wins when set.</p>}
    </form>
  );
}

export function RelayUnreachable({ error, draftRoot, onDraftRoot }: { error: unknown; draftRoot: string; onDraftRoot: (name: string) => void }) {
  const message = error instanceof Error ? errorText(error) : "No response";
  return (
    <LiveNotice title="Can't reach the relay API" tone="warning">
      <p>{`${message} (GET /api/relay/status). Chain reads still work on the company name you type here.`}</p>
      <DraftRootField key={draftRoot} value={draftRoot} onChange={onDraftRoot} />
    </LiveNotice>
  );
}

export function NoRootNotice({ draftRoot, onDraftRoot, onOpenSetup }: { draftRoot: string; onDraftRoot: (name: string) => void; onOpenSetup: () => void }) {
  return (
    <LiveNotice title="No company name yet">
      <p>The relay has no RELAY_ROOT_NAME. Type the .eth name you own, or register one in Setup.</p>
      <DraftRootField key={draftRoot} value={draftRoot} onChange={onDraftRoot} />
      <button type="button" className="parent-link" onClick={onOpenSetup}>
        Open setup
      </button>
    </LiveNotice>
  );
}

/** The relay runs in production without RELAY_ADMIN_TOKEN: nobody can sign in, so say how to open it. */
export function RelayClosed() {
  return (
    <LiveNotice title="The relay's log and spend are closed">
      <p>
        This relay shows decisions and spend only to agent tokens. Once admin sign-in is turned on for the relay,{" "}
        <a href={ADMIN_SIGN_IN}>sign in as admin</a> to see them here.
      </p>
    </LiveNotice>
  );
}

/** Shown where relay reads answer 401: the root owner signs in with their wallet (or the admin with the token), once per browser. */
export function AdminSignIn({ what }: { what: string }) {
  return (
    <LiveNotice title="Sign in to see relay data" tone="warning">
      <p>
        <AdminSignInPrompt what={what} />
      </p>
    </LiveNotice>
  );
}
