"use client";

// Challenge → wallet signature → (World Selfie Check) → confirm, shared by approvals and enrollment.
// Any failure leaves the subject as it was (still paused); "Start again" asks for a new challenge.

import { useRef, useState } from "react";
import type { Hex } from "viem";
import { useSignMessage } from "wagmi";

import { RelayApiError } from "@/lib/relay/browser";

import type { Challenge, ConfirmResponse } from "./api";
import { approvalsApi } from "./api";
import { errorWords } from "./logic";

export type FlowPhase = "idle" | "challenge" | "sign" | "world" | "confirm" | "done" | "failed";

export type SignedFlow = {
  phase: FlowPhase;
  challenge: Challenge | null;
  result: ConfirmResponse | null;
  /** Error code (e.g. incident_changed) and words, when failed. */
  error: { code: string; text: string } | null;
  /** The World widget should be open. */
  worldOpen: boolean;
  start: () => Promise<void>;
  onWorldSuccess: (result: unknown) => Promise<void>;
  onWorldError: (code: string) => void;
  onWorldClosed: () => void;
  cancel: () => Promise<void>;
  reset: () => void;
};

function failure(e: unknown): { code: string; text: string } {
  if (e instanceof RelayApiError) {
    const code = e.message;
    const words = errorWords(code);
    return { code, text: e.reason && e.reason !== words ? `${words} ${e.reason}` : words };
  }
  const message = e instanceof Error ? e.message : String(e);
  if (/user (rejected|denied)|rejected the request/i.test(message)) return { code: "wallet_cancelled", text: "The wallet signature was cancelled." };
  return { code: "error", text: message };
}

export function useSignedFlow(opts: {
  issue: () => Promise<Challenge>;
  confirm: (challenge: Challenge, signature: Hex, world: unknown | undefined) => Promise<ConfirmResponse>;
  onDone?: (result: ConfirmResponse) => void;
}): SignedFlow {
  const { mutateAsync: signMessage } = useSignMessage();
  const [phase, setPhase] = useState<FlowPhase>("idle");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [result, setResult] = useState<ConfirmResponse | null>(null);
  const [error, setError] = useState<SignedFlow["error"]>(null);
  const signature = useRef<Hex | null>(null);
  const confirming = useRef(false);

  const fail = (e: unknown) => {
    setError(failure(e));
    setPhase("failed");
  };

  const confirm = async (c: Challenge, world: unknown | undefined) => {
    if (confirming.current || !signature.current) return;
    confirming.current = true;
    setPhase("confirm");
    try {
      const res = await opts.confirm(c, signature.current, world);
      setResult(res);
      setPhase("done");
      opts.onDone?.(res);
    } catch (e) {
      fail(e);
    } finally {
      confirming.current = false;
    }
  };

  const start = async () => {
    setError(null);
    setResult(null);
    signature.current = null;
    setPhase("challenge");
    let c: Challenge;
    try {
      c = await opts.issue();
      setChallenge(c);
    } catch (e) {
      return fail(e);
    }
    setPhase("sign");
    try {
      signature.current = await signMessage({ message: c.message });
    } catch (e) {
      // Tell the relay the challenge is dead; nothing changed either way.
      void approvalsApi.cancel(c.id).catch(() => {});
      return fail(e);
    }
    if (c.world) setPhase("world");
    else await confirm(c, undefined);
  };

  return {
    phase,
    challenge,
    result,
    error,
    worldOpen: phase === "world",
    start,
    onWorldSuccess: async (world) => {
      if (challenge) await confirm(challenge, world);
    },
    onWorldError: (code) => {
      if (challenge) void approvalsApi.cancel(challenge.id).catch(() => {});
      setError({ code, text: errorWords(code) });
      setPhase("failed");
    },
    onWorldClosed: () => {
      if (phase !== "world") return;
      if (challenge) void approvalsApi.cancel(challenge.id).catch(() => {});
      setError({ code: "widget_closed", text: errorWords("widget_closed") });
      setPhase("failed");
    },
    cancel: async () => {
      if (challenge && (phase === "sign" || phase === "world")) await approvalsApi.cancel(challenge.id).catch(() => {});
      setError({ code: "cancelled", text: "Cancelled. Nothing changed." });
      setPhase("failed");
    },
    reset: () => {
      setPhase("idle");
      setChallenge(null);
      setResult(null);
      setError(null);
      signature.current = null;
    },
  };
}
