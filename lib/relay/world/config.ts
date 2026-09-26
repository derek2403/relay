// World ID settings for approver verification (Selfie Check, legacy 3.0
// uniqueness proofs). Read from the environment (.env), never from the
// credentials store or the Providers page. The signing key never leaves the
// server and is never logged.
//
// WORLD_APP_ID              app_…   (sent to the browser with each challenge)
// WORLD_RP_ID               rp_…    (verify URL and rp_context)
// WORLD_RP_SIGNING_KEY      0x + 64 hex, server only
// WORLD_ACTION              stable action string; never rotate it (nullifiers are per action)
// WORLD_ENVIRONMENT         production | staging (no default)
// WORLD_RP_SIGNER_ADDRESS   optional: preflight compares it with the key's address
// WORLD_PORTAL_URL          optional, default https://developer.world.org
// WORLD_STAGING_VERIFICATION_TOKEN  optional, sent as x-staging-verification-token

import { type Address, type Hex, getAddress, isAddress } from "viem";

/** The only proof version accepted (a code constant: 3.0 and 4.0 nullifiers can't be linked). */
export const PROOF_VERSION = "3.0";
export const DEFAULT_PORTAL_URL = "https://developer.world.org";
export const WORLD_ENVIRONMENTS = ["production", "staging"] as const;
export type WorldEnvironment = (typeof WORLD_ENVIRONMENTS)[number];

export type WorldConfig = {
  appId: string;
  rpId: string;
  signingKey: Hex;
  action: string;
  environment: WorldEnvironment;
  signerAddress: Address | null;
  portalUrl: string;
  stagingToken: string | null;
};

export type WorldProblem = { name: string; issue: string; fix: string };

type Env = Record<string, string | undefined>;

const clean = (v: string | undefined) => (v ?? "").trim();

/** Parses the WORLD_* variables; `config` is null with at least one problem when anything required is missing or malformed. */
export function worldConfig(env: Env = process.env): { config: WorldConfig | null; problems: WorldProblem[] } {
  const problems: WorldProblem[] = [];
  const appId = clean(env.WORLD_APP_ID);
  const rpId = clean(env.WORLD_RP_ID);
  const key = clean(env.WORLD_RP_SIGNING_KEY);
  const action = clean(env.WORLD_ACTION);
  const environment = clean(env.WORLD_ENVIRONMENT);
  const signer = clean(env.WORLD_RP_SIGNER_ADDRESS);
  const portal = clean(env.WORLD_PORTAL_URL).replace(/\/+$/, "") || DEFAULT_PORTAL_URL;

  if (!appId) problems.push({ name: "WORLD_APP_ID", issue: "Not set.", fix: "Copy the App ID from your app's overview in the Developer Portal." });
  else if (!appId.startsWith("app_")) {
    problems.push({ name: "WORLD_APP_ID", issue: `Must start with "app_", got "${appId.slice(0, 12)}…".`, fix: "Copy the App ID, not the app name or the RP ID." });
  }
  if (!rpId) problems.push({ name: "WORLD_RP_ID", issue: "Not set.", fix: "Take it from World ID Configuration after RP registration is active." });
  else if (!rpId.startsWith("rp_")) {
    problems.push({ name: "WORLD_RP_ID", issue: `Must start with "rp_", got "${rpId.slice(0, 12)}…".`, fix: "Copy the RP ID from World ID Configuration, not the App ID." });
  }
  if (!key) {
    problems.push({ name: "WORLD_RP_SIGNING_KEY", issue: "Not set.", fix: "Copy the signing key from World ID Configuration. Server-side only: never prefix it with NEXT_PUBLIC_." });
  } else if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    problems.push({
      name: "WORLD_RP_SIGNING_KEY",
      issue: "Must be 0x followed by 64 hex characters (a 32-byte secp256k1 key).",
      fix: "Re-copy the key from the portal; a truncated paste fails only as invalid_rp_signature.",
    });
  }
  if (!action) {
    problems.push({
      name: "WORLD_ACTION",
      issue: "Not set. There is deliberately no default.",
      fix: "Set a stable action string (e.g. relay-approver) and never change it: nullifiers are scoped per action, so rotating it unlinks every approver.",
    });
  }
  if (!environment) {
    problems.push({
      name: "WORLD_ENVIRONMENT",
      issue: "Not set. There is deliberately no default.",
      fix: "production or staging. It must match the environment your app_id and rp_id are registered in, or proofs fail as invalid_merkle_root.",
    });
  } else if (!(WORLD_ENVIRONMENTS as readonly string[]).includes(environment)) {
    problems.push({ name: "WORLD_ENVIRONMENT", issue: `"${environment.slice(0, 20)}" is not a valid environment.`, fix: "Use production (real World App) or staging (the simulator)." });
  }
  if (signer && !isAddress(signer, { strict: false })) {
    problems.push({ name: "WORLD_RP_SIGNER_ADDRESS", issue: "Must be a 0x-prefixed 20-byte address.", fix: 'Copy the "Signer address" field from World ID Configuration, or unset it.' });
  }
  if (!/^https?:\/\//.test(portal)) {
    problems.push({ name: "WORLD_PORTAL_URL", issue: "Must be an http(s) URL.", fix: `Unset it to use ${DEFAULT_PORTAL_URL}.` });
  }
  if (problems.length) return { config: null, problems };
  return {
    config: {
      appId,
      rpId,
      signingKey: key as Hex,
      action,
      environment: environment as WorldEnvironment,
      signerAddress: signer ? getAddress(signer) : null,
      portalUrl: portal,
      stagingToken: clean(env.WORLD_STAGING_VERIFICATION_TOKEN) || null,
    },
    problems,
  };
}

/** The `world` block of /api/relay/status: no secrets, only whether it's set up and what's wrong. */
export function worldStatus(env: Env = process.env): { configured: boolean; environment: string; problems: string[] } {
  const { config, problems } = worldConfig(env);
  return {
    configured: !!config,
    environment: config?.environment ?? (clean(env.WORLD_ENVIRONMENT).slice(0, 20) || "unset"),
    problems: problems.map((p) => `${p.name}: ${p.issue}`),
  };
}
