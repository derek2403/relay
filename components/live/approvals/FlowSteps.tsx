"use client";

import dynamic from "next/dynamic";

import { Steps } from "@/components/live/tx/Steps";

import { worldNotes } from "./logic";
import type { SignedFlow } from "./useSignedFlow";

// IDKit touches window and WASM: browser only.
const WorldWidget = dynamic(() => import("./WorldWidget"), { ssr: false });

export const WORLD_COPY = "Selfie Check in World App: proves the same enrolled person is here now. It does not judge the decision.";

/** The signed flow's progress, the World widget when it's needed, and the outcome or error. */
export function FlowSteps({ flow, world, doneText, failedText }: { flow: SignedFlow; world: boolean; doneText: string; failedText: string }) {
  const order = ["challenge", "sign", "world", "confirm", "done"] as const;
  const at = flow.phase === "failed" ? -1 : order.indexOf(flow.phase as (typeof order)[number]);
  const past = (p: (typeof order)[number]) => at > order.indexOf(p);
  const env = flow.challenge?.world?.environment;
  if (flow.phase === "idle") return null;
  return (
    <div className="appr-flow" aria-live="polite">
      <Steps
        steps={[
          { label: "Challenge from the relay (valid 5 minutes)", done: past("challenge") },
          { label: "Sign the exact decision with your wallet", done: past("sign") },
          ...(world
            ? [
                {
                  label: (
                    <>
                      World ID Selfie Check {env && <span className={`status-pill appr-env env-${env}`}>{env}</span>}
                    </>
                  ),
                  done: past("world"),
                  detail: (
                    <>
                      <p className="live-why">{WORLD_COPY} On a computer, scan the QR code with World App.</p>
                      {worldNotes({ environment: env ?? null }).map((n) => (
                        <p key={n} className="live-why appr-note">
                          {n}
                        </p>
                      ))}
                    </>
                  ),
                },
              ]
            : []),
          { label: "The relay verifies everything and applies it", done: flow.phase === "done" },
        ]}
      />
      {flow.phase === "sign" && <p className="form-hint">Check your wallet: the message names the decision, the scope and the challenge.</p>}
      {flow.challenge?.world && (
        <WorldWidget
          request={flow.challenge.world}
          open={flow.worldOpen}
          onSuccess={(r) => void flow.onWorldSuccess(r)}
          onError={flow.onWorldError}
          onClosed={flow.onWorldClosed}
        />
      )}
      {flow.phase === "done" && <p className="appr-outcome ok">{doneText}</p>}
      {flow.phase === "failed" && flow.error && (
        <div className="appr-outcome bad" role="alert">
          <b>{failedText}</b>
          <p>
            {flow.error.text} <span className="mono">({flow.error.code})</span>
          </p>
        </div>
      )}
      {flow.challenge?.digest && flow.phase !== "failed" && <p className="appr-digest mono">digest {flow.challenge.digest}</p>}
    </div>
  );
}
