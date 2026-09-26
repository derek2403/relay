// Server-side checks of an IDKit result (legacy 3.0 Selfie Check) and the
// Developer Portal v4 verify call. The client's result is untrusted input:
// it is checked locally first (protocol, credential, signal, nonce, action),
// then forwarded to the Portal unchanged except `environment`, which is pinned
// to WORLD_ENVIRONMENT so a client can't pick a test environment.
//
// Acceptance: HTTP 200, success === true, and the selfie entry in results[]
// succeeded (a top-level success only means some credential passed), and the
// Portal's environment (when it reports one) equals the configured one.

import type { Hex } from "viem";

import { PROOF_VERSION, type WorldConfig } from "./config";
import { hashSignal } from "./rp";

export const PORTAL_TIMEOUT_MS = 10_000;
const SELFIE_IDS = ["selfie", "face"];

/** What the challenge expects the proof to be bound to. */
export type WorldExpect = { signal: string; nonce: Hex | string; action: string };

export type WorldFailure = { ok: false; status: number; code: string; detail: string };
export type WorldSuccess = { ok: true; nullifier: Hex; environment: string; presence: boolean | null };

const fail = (status: number, code: string, detail: string): WorldFailure => ({ ok: false, status, code, detail });

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A nullifier as lowercase 32-byte hex, whether it came as hex or decimal; null when it isn't one. */
export function normalizeNullifier(raw: unknown): Hex | null {
  if (typeof raw !== "string" || !raw || raw.length > 80) return null;
  try {
    const n = BigInt(raw);
    if (n < 0n || n >= 1n << 256n) return null;
    return `0x${n.toString(16).padStart(64, "0")}` as Hex;
  } catch {
    return null;
  }
}

/**
 * Local checks, no network: protocol 3.0, exactly one response and it is the
 * selfie credential, its signal_hash equals hashSignal(expected signal), and
 * the nonce and action are the challenge's.
 */
export function checkWorldResult(result: unknown, expect: WorldExpect): { ok: true; result: Record<string, unknown> } | WorldFailure {
  if (!isObject(result)) return fail(400, "missing_result", "send the IDKit result as `world`");
  if (result.protocol_version !== PROOF_VERSION) return fail(422, "wrong_protocol_version", `only World ID ${PROOF_VERSION} (legacy Selfie Check) proofs are accepted`);
  const responses = result.responses;
  if (!Array.isArray(responses) || responses.length !== 1 || !isObject(responses[0])) {
    return fail(422, "wrong_credential", "expected exactly one Selfie Check response");
  }
  const item = responses[0];
  if (typeof item.identifier !== "string" || !SELFIE_IDS.includes(item.identifier)) return fail(422, "wrong_credential", "the response is not a Selfie Check credential");
  if (typeof item.signal_hash !== "string" || item.signal_hash.toLowerCase() !== hashSignal(expect.signal).toLowerCase()) {
    return fail(422, "signal_mismatch", "the proof is bound to a different challenge");
  }
  if (typeof result.nonce !== "string" || result.nonce.toLowerCase() !== String(expect.nonce).toLowerCase()) {
    return fail(422, "nonce_mismatch", "the proof was requested with a different rp_context");
  }
  if (result.action !== undefined && result.action !== expect.action) return fail(422, "action_mismatch", "the proof is for a different action");
  if (normalizeNullifier(item.nullifier) === null) return fail(422, "wrong_credential", "the response has no nullifier");
  return { ok: true, result };
}

/** Removes most of the proof before a result is shown or stored. */
export function redactResult(result: Record<string, unknown>): Record<string, unknown> {
  const responses = Array.isArray(result.responses)
    ? result.responses.map((r) => (isObject(r) && typeof r.proof === "string" ? { ...r, proof: `${r.proof.slice(0, 18)}… (truncated)` } : r))
    : result.responses;
  return { ...result, responses };
}

/**
 * POSTs the (locally checked) result to `${portal}/api/v4/verify/${rp_id}`
 * with `environment` and `action` pinned, and applies the acceptance rule.
 * Errors: `world_rejected:<code>` (422), `environment_mismatch` (422),
 * `world_unreachable` (502: network, timeout, non-JSON, 5xx).
 */
export async function verifyWithPortal(
  config: Pick<WorldConfig, "rpId" | "portalUrl" | "environment" | "action" | "stagingToken">,
  result: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<WorldSuccess | WorldFailure> {
  const url = `${config.portalUrl}/api/v4/verify/${encodeURIComponent(config.rpId)}`;
  const body = { ...result, action: config.action, environment: config.environment };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.stagingToken) headers["x-staging-verification-token"] = config.stagingToken;
  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(PORTAL_TIMEOUT_MS) });
    text = await res.text();
  } catch (err) {
    const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return fail(502, "world_unreachable", timeout ? "the World Developer Portal did not answer in time" : "the World Developer Portal could not be reached");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail(502, "world_unreachable", `the World Developer Portal answered HTTP ${res.status} without JSON`);
  }
  if (!isObject(json)) return fail(502, "world_unreachable", `the World Developer Portal answered HTTP ${res.status} with an unexpected body`);
  const results = Array.isArray(json.results) ? json.results.filter(isObject) : [];
  const selfie = results.find((r) => typeof r.identifier === "string" && SELFIE_IDS.includes(r.identifier));
  if (!(res.status === 200 && json.success === true && selfie?.success === true)) {
    if (res.status >= 500) return fail(502, "world_unreachable", `the World Developer Portal answered HTTP ${res.status}`);
    const code = String((selfie?.code as string | undefined) ?? (json.code as string | undefined) ?? (res.status === 200 ? "selfie_not_verified" : `http_${res.status}`)).slice(0, 60);
    return fail(422, `world_rejected:${code.replace(/[^a-z0-9_.-]/gi, "_")}`, `World rejected the proof (${code})`);
  }
  const environment = typeof json.environment === "string" ? json.environment : config.environment;
  if (environment !== config.environment) return fail(422, "environment_mismatch", `the proof verified in ${environment}, not ${config.environment}`);
  const items = Array.isArray(result.responses) ? result.responses : [];
  const nullifier = normalizeNullifier(selfie.nullifier) ?? normalizeNullifier(json.nullifier) ?? normalizeNullifier(isObject(items[0]) ? items[0].nullifier : null);
  if (!nullifier) return fail(422, "world_rejected:no_nullifier", "World did not return a nullifier");
  // The item's own nullifier must be the one World verified (it is what we check against the enrollment).
  const claimed = normalizeNullifier(isObject(items[0]) ? items[0].nullifier : null);
  if (claimed && claimed !== nullifier) return fail(422, "world_rejected:nullifier_mismatch", "the verified nullifier differs from the one in the proof");
  const presence = typeof result.user_presence_completed === "boolean" ? result.user_presence_completed : null;
  return { ok: true, nullifier, environment, presence };
}

/** Local checks, then the Portal. */
export async function verifyWorldProof(
  config: WorldConfig,
  raw: unknown,
  expect: WorldExpect,
  fetchImpl: typeof fetch = fetch,
): Promise<WorldSuccess | WorldFailure> {
  const local = checkWorldResult(raw, expect);
  if (!local.ok) return local;
  return verifyWithPortal(config, local.result, fetchImpl);
}
