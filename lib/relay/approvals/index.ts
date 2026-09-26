// The approvals runtime for the running server: the store under
// RELAY_DATA_DIR, the guard registered with lib/relay/guard.ts at module load
// (instrumentation.ts imports this module so it's registered at server start),
// and the deps bag the route handlers use.

import { getConfig } from "../config";
import { getChainReader } from "../ens";
import { registerGuardFactory } from "../guard";
import { getMeter } from "../meter";
import { RateLimiter, relayLimits } from "../ratelimit";
import { type ApprovalsDeps, signatureVerifier } from "./api";
import { approvalsGuard } from "./guard";
import { getApprovalsStore } from "./store";
import { knownRecipients } from "./workspace";

const g = globalThis as unknown as { __relayConfirmLimit?: RateLimiter };

/** Deps for the approvals routes, from the server's config. */
export function approvalsDeps(): ApprovalsDeps {
  const config = getConfig();
  return {
    config,
    reader: getChainReader(config.rpcUrl, config.logsRpcUrl),
    meter: getMeter(config.dataDir),
    store: getApprovalsStore(config.dataDir),
    env: process.env,
    fetch,
    verifySignature: signatureVerifier(config.rpcUrl),
    now: () => Date.now(),
    limits: relayLimits(),
    knownRecipients: () => knownRecipients(process.env),
    confirmLimit: (g.__relayConfirmLimit ??= new RateLimiter(60, 1)),
  };
}

/** Builds the server's guard from the approvals store (the data dir is read when it's built). */
export function ensureGuard() {
  registerGuardFactory(() => {
    const config = getConfig();
    return approvalsGuard({
      store: getApprovalsStore(config.dataDir),
      meter: () => getMeter(config.dataDir),
      root: () => config.rootName,
      rootOwner: () => config.rootOwner,
      knownRecipients: () => knownRecipients(process.env),
    });
  });
}

ensureGuard();
