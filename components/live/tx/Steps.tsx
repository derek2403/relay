"use client";

import type { ReactNode } from "react";

import { currentStep } from "./txView";

export type Step = { label: ReactNode; done: boolean; active?: boolean; detail?: ReactNode };


/**
 * A numbered checklist (SRC Checklist/Check): done steps ticked, inactive ones dimmed, the active one highlighted.
 * `active: false` dims a step whose prerequisites aren't met yet; the first open step is the current one.
 */
export function Steps({ steps }: { steps: readonly Step[] }) {
  const current = currentStep(steps);
  return (
    <ol className="live-steps">
      {steps.map((step, i) => {
        const state = step.done ? "done" : i === current ? "current" : step.active === false ? "blocked" : "open";
        return (
          <li key={i} className={`live-step ${state}`} aria-current={state === "current" ? "step" : undefined}>
            <span className="live-step-mark" aria-hidden="true">
              {step.done ? "✓" : i + 1}
            </span>
            <div className="live-step-body">
              <span className="live-step-label">{step.label}</span>
              {step.detail}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Small muted explanation of why an action isn't available (SRC Why). */
export function Why({ children }: { children: ReactNode }) {
  return <p className="live-why">{children}</p>;
}
