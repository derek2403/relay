"use client";

import { type FormEvent, useState } from "react";

import { useLive } from "@/components/live/LiveContext";
import { cx } from "@/lib/cx";
import { formatError } from "@/lib/ens/errors";
import { useNow } from "@/lib/hooks/useNow";
import { useRelayAgentKeys } from "@/lib/hooks/useRelayAgents";
import { useRelayLog, useRelayPolicy } from "@/lib/hooks/useRelayApi";
import { agentToken, errorText, needsSignIn, nowSec, usd } from "@/lib/relay/browser";
import { PROVIDERS } from "@/lib/relay/bundle";
import type { LogEntry } from "@/lib/relay/types";

import {
  type CallResult,
  classifyResponse,
  keysUnderRoot,
  matchLogEntry,
  relayUrl,
  requestHeaders,
  sendsBody,
  sessionCheck,
  tryMethods,
  trySample,
  tryTokenExpiry,
} from "./model";

type Req = { method: string; path: string; body: string };

/** Sends a real request through the relay as one of this browser's agents (SRC TryCall, F14). */
export function TryCall({ log }: { log: { data: LogEntry[] | undefined; refetch: () => Promise<unknown> } }) {
  const live = useLive();
  const agents = useRelayAgentKeys();
  const now = useNow();
  const named = keysUnderRoot(agents.keys, live.root);

  const [agentAddr, setAgentAddr] = useState("");
  const [provider, setProvider] = useState("mock");
  const [edits, setEdits] = useState<Record<string, Req>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CallResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const key = named.find((k) => k.address === agentAddr) ?? named[0];
  // The relay's view of the chosen name: is it still live, and when does it end?
  const policy = useRelayPolicy(key?.name ?? null);
  const { leaf, expiry, ended } = sessionCheck(policy.data?.levels ?? [], key?.name, now || nowSec());
  const sample = trySample(provider);
  const req: Req = edits[provider] ?? { method: sample.method, path: sample.path, body: sample.body ?? "" };
  const setReq = (patch: Partial<Req>) => setEdits({ ...edits, [provider]: { ...req, ...patch } });
  const providers: { id: string; label: string; configured?: boolean }[] = live.status?.providers.length ? live.status.providers : PROVIDERS;
  const configured = live.status?.providers.find((p) => p.id === provider)?.configured;

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!key?.name) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      // A short-lived token is enough for one test call, and never outlives the session.
      const token = await agentToken(key, key.name, tryTokenExpiry(nowSec(), expiry));
      const withBody = sendsBody(req.method, req.body);
      const sentAt = Date.now();
      const res = await fetch(relayUrl(provider, req.path), {
        method: req.method,
        headers: requestHeaders(sample.auth, token, withBody),
        body: withBody ? req.body : undefined,
      });
      const r = classifyResponse(res.status, await res.text(), sentAt);
      setResult(r);
      live.log(r.denied ? "Call refused" : "Call sent", `${key.name} · ${provider} ${req.method} ${req.path} · HTTP ${r.status}`);
      live.toast(r.denied ? "Refused by the relay." : `Allowed. HTTP ${r.status}.`);
      // The relay logs (and charges) once the response body has been read.
      await log.refetch();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  if (named.length === 0) {
    return (
      <p className="form-hint">
        No agent keys {live.root ? `for names under ${live.root} ` : ""}in this browser yet. Start an agent session on a member first.
      </p>
    );
  }

  const entry = result && key ? matchLogEntry(log.data, { sentAt: result.sentAt, provider, name: key.name, address: key.address }) : undefined;

  return (
    <div className="provider-card agents-card">
      <form className="agents-form" onSubmit={(e) => void send(e)}>
        <div className="form-row">
          <label>
            As agent
            <select value={key?.address ?? ""} onChange={(e) => setAgentAddr(e.target.value)}>
              {named.map((k) => (
                <option key={k.address} value={k.address}>
                  {k.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Provider
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.configured === false ? " (no key)" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-row agents-request-row">
          <label>
            Method
            <select value={req.method} onChange={(e) => setReq({ method: e.target.value })}>
              {tryMethods(provider).map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label>
            Path
            <input value={req.path} onChange={(e) => setReq({ path: e.target.value })} spellCheck={false} className="mono" />
          </label>
        </div>
        {configured === false && <p className="form-hint">The relay has no key for this provider, so it will refuse the call.</p>}
        {ended && <p className="form-hint">This session has ended or was removed, so the relay would refuse it. Extend it in the tree, or start a new one.</p>}
        {policy.error && !needsSignIn(policy.error) && <p className="form-hint">Couldn&apos;t check the session: {errorText(policy.error)}</p>}
        {policy.data && !leaf && policy.data.reason && <p className="form-hint">The relay will refuse it: {policy.data.reason}</p>}
        {req.method !== "GET" && (
          <label className="agents-body-label">
            Body
            <textarea className="agents-textarea mono" value={req.body} onChange={(e) => setReq({ body: e.target.value })} rows={6} spellCheck={false} />
          </label>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="dialog-footer">
          <button type="submit" className="primary agents-send" disabled={busy || !key || ended || policy.isLoading}>
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
      </form>

      {result && (
        <div className="agents-result" aria-live="polite">
          <div className="agents-result-head">
            <span className={cx("status-pill", result.denied && "revoked")}>{result.denied ? "Refused by the relay" : "Allowed"}</span>
            <span className="mono">HTTP {result.status}</span>
            {entry?.costUsd !== null && entry?.costUsd !== undefined && (
              <span className="mono">
                cost {usd(entry.costUsd)}
                {entry.estimated ? " (estimated)" : ""}
              </span>
            )}
          </div>
          {result.reason && <p className="agents-why">Why: {result.reason}</p>}
          <pre className="agents-pre">{result.body || "(empty)"}</pre>
        </div>
      )}
    </div>
  );
}
