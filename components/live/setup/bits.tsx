"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

import type { Tx } from "@/lib/hooks/useTx";

/** A khaki setup card: status pill, title, one-line description, then the body. */
export function SetupCard({
  id,
  index,
  title,
  pill,
  description,
  children,
}: {
  id: string;
  index: string;
  title: string;
  pill?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <article className="provider-card live-setup-card" id={id} aria-labelledby={`${id}-title`}>
      <div className="live-setup-card-top">
        <span className="live-setup-index">{index}</span>
        {pill}
      </div>
      <h2 id={`${id}-title`}>{title}</h2>
      {description && <p className="live-setup-description">{description}</p>}
      <div className="live-setup-body">{children}</div>
    </article>
  );
}

export function Pill({ tone = "neutral", children }: { tone?: "neutral" | "ok" | "warn" | "bad"; children: ReactNode }) {
  return <span className={`status-pill live-setup-pill ${tone}`}>{children}</span>;
}

/** Small explanation of why an action isn't available (SRC Why). */
export function Why({ children }: { children: ReactNode }) {
  return <p className="live-setup-why">{children}</p>;
}

/** Monospace block with a Copy button. */
export function CopyBlock({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <div className="live-setup-code">
      <pre>{text}</pre>
      <button
        type="button"
        className="secondary"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "Copied" : label}
      </button>
    </div>
  );
}

/** Calls `onSuccess` once per confirmed transaction of `tx` (for hooks whose write returns nothing). */
export function useOnTxSuccess(tx: Tx, onSuccess: () => void) {
  const cb = useRef(onSuccess);
  useEffect(() => {
    cb.current = onSuccess;
  });
  const seen = useRef<string | null>(null);
  const { state } = tx;
  useEffect(() => {
    if (state.status !== "success" || seen.current === state.hash) return;
    seen.current = state.hash;
    cb.current();
  }, [state]);
}
