// World ID preflight: is approver verification set up? Config problems, an RP
// signing self-test, the signer-address match, and a probe of the Portal's v4
// verify endpoint with a deliberately fake 3.0 proof. The fake proof can't
// verify: `all_verifications_failed` means the endpoint, rp_id and RP
// registration are fine (the proof reached the cryptographic checks).
// Whether Selfie Check is enabled for the app can't be seen server-side.

import { hexToBytes } from "viem";

import { type WorldConfig, worldConfig } from "./config";
import { hashSignal, rpSignerAddress, signRpContext } from "./rp";

export type CheckStatus = "ok" | "blocked" | "unknown";
export type PreflightCheck = { id: string; label: string; status: CheckStatus; detail: string; fix?: string; code?: string };
export type Preflight = { configured: boolean; environment: string | null; checks: PreflightCheck[] };

const ZERO32 = `0x${"00".repeat(32)}`;

/** The fake body: well-formed, all zeros, a junk proof. Never a real proof. */
export const fakeProbeBody = (config: Pick<WorldConfig, "action" | "environment">) => ({
  protocol_version: "3.0",
  nonce: ZERO32,
  action: config.action,
  environment: config.environment,
  responses: [{ identifier: "selfie", signal_hash: hashSignal("relay-preflight"), proof: `0x${"11".repeat(256)}`, merkle_root: ZERO32, nullifier: ZERO32 }],
});

/** Classifies the Portal's answer to the fake proof. */
export function classifyProbe(status: number, body: unknown): Pick<PreflightCheck, "status" | "detail" | "fix" | "code"> {
  const json = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const code = typeof json.code === "string" ? json.code : status === 200 ? "accepted" : `http_${status}`;
  switch (code) {
    case "all_verifications_failed":
      return { status: "ok", code, detail: "The verify endpoint answered the fake proof with all_verifications_failed: the rp_id and RP registration work." };
    case "integrity_verification_failed":
      return { status: "ok", code, detail: "The fake proof stopped at the device-attestation gate: the endpoint and rp_id work." };
    case "rp_not_active":
      return { status: "blocked", code, detail: "The RP isn't active.", fix: "Finish RP registration in the Developer Portal; until then World App refuses requests (inactive_rp)." };
    case "validation_error":
      return { status: "blocked", code, detail: "The Portal rejected the request shape.", fix: "Check WORLD_ACTION and WORLD_ENVIRONMENT." };
    case "app_not_migrated":
      return { status: "blocked", code, detail: "The app isn't migrated to World ID 4 verification.", fix: "Complete RP registration in the Developer Portal." };
    case "accepted":
      return { status: "blocked", code, detail: "The Portal accepted a fake proof. Don't trust this endpoint.", fix: "Check WORLD_PORTAL_URL." };
    default:
      return { status: "unknown", code, detail: `The Portal answered ${code}.` };
  }
}

/** Runs every check; never throws (network failures become a check). */
export async function runPreflight(env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Promise<Preflight> {
  const { config, problems } = worldConfig(env);
  if (!config) {
    return {
      configured: false,
      environment: null,
      checks: problems.map((p) => ({ id: "env", label: p.name, status: "blocked" as const, detail: p.issue, fix: p.fix })),
    };
  }
  const checks: PreflightCheck[] = [
    { id: "env", label: "Credentials", status: "ok", detail: `app_id, rp_id and signing key loaded. action="${config.action}".` },
    {
      id: "environment",
      label: "Environment",
      status: "ok",
      detail:
        config.environment === "production"
          ? "production: proofs from the public World App."
          : "staging: simulator proofs. This demonstrates the integration only, not liveness or spoof resistance.",
    },
  ];
  try {
    const ctx = await signRpContext(config);
    const ok = hexToBytes(ctx.signature).length === 65;
    checks.push({ id: "signing", label: "RP signature", status: ok ? "ok" : "blocked", detail: ok ? "rp_context signed (65-byte signature)." : "The signature isn't 65 bytes.", ...(ok ? {} : { fix: "Re-copy the signing key from the portal." }) });
  } catch {
    checks.push({ id: "signing", label: "RP signature", status: "blocked", detail: "Signing failed.", fix: "Re-copy the signing key from the portal." });
  }
  const derived = rpSignerAddress(config.signingKey);
  if (!config.signerAddress) {
    checks.push({ id: "signer", label: "Signer address", status: "unknown", detail: `The key's address is ${derived}. Set WORLD_RP_SIGNER_ADDRESS to compare it with the portal.` });
  } else if (config.signerAddress.toLowerCase() === derived.toLowerCase()) {
    checks.push({ id: "signer", label: "Signer address", status: "ok", detail: `The key matches the portal's signer ${derived}.` });
  } else {
    checks.push({
      id: "signer",
      label: "Signer address",
      status: "blocked",
      detail: `The key's address ${derived} isn't WORLD_RP_SIGNER_ADDRESS ${config.signerAddress}.`,
      fix: "The key was rotated or copied from another app; re-copy it.",
    });
  }
  const url = `${config.portalUrl}/api/v4/verify/${encodeURIComponent(config.rpId)}`;
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.stagingToken) headers["x-staging-verification-token"] = config.stagingToken;
    const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(fakeProbeBody(config)), cache: "no-store", signal: AbortSignal.timeout(10_000) });
    let body: unknown = null;
    try {
      body = JSON.parse(await res.text());
    } catch {}
    checks.push({ id: "rp", label: "Verify endpoint (v4)", ...classifyProbe(res.status, body) });
  } catch {
    checks.push({ id: "rp", label: "Verify endpoint (v4)", status: "unknown", code: "network_error", detail: `Couldn't reach ${config.portalUrl}.` });
  }
  checks.push({
    id: "selfie_flag",
    label: "Selfie Check enabled",
    status: "unknown",
    detail: "Not visible server-side. World App reports feature_unavailable on the first real request if it isn't.",
  });
  return { configured: true, environment: config.environment, checks };
}
