"use client";

// IDKit's widget (World ID 3.0 Selfie Check, legacy preset), loaded only in the browser through
// next/dynamic (ssr: false) by WorldStep. Everything it asks for comes from the relay's challenge:
// app_id, action, rp_context (signed by the relay), signal (bound to the decision) and environment.
// A success here authorizes nothing; the relay verifies the proof with World before it acts.

import { type IDKitErrorCodes, type IDKitResult, IDKitRequestWidget, selfieCheckLegacy } from "@worldcoin/idkit";
import { useRef } from "react";

import type { WorldRequest } from "./api";

export type WorldWidgetProps = {
  request: WorldRequest;
  open: boolean;
  onSuccess: (result: IDKitResult) => void;
  onError: (code: string) => void;
  /** The widget closed with no result (after a short grace period, as close can race success). */
  onClosed: () => void;
};

export default function WorldWidget({ request, open, onSuccess, onError, onClosed }: WorldWidgetProps) {
  const settled = useRef(false);
  return (
    <IDKitRequestWidget
      open={open}
      onOpenChange={(next) => {
        if (next) {
          settled.current = false;
          return;
        }
        setTimeout(() => {
          if (!settled.current) onClosed();
        }, 400);
      }}
      app_id={request.app_id}
      action={request.action}
      rp_context={request.rp_context}
      environment={request.environment}
      allow_legacy_proofs
      require_user_presence={request.require_user_presence ?? true}
      preset={selfieCheckLegacy({ signal: request.signal })}
      onSuccess={(result) => {
        settled.current = true;
        onSuccess(result);
      }}
      onError={(code: IDKitErrorCodes) => {
        settled.current = true;
        onError(String(code));
      }}
    />
  );
}
