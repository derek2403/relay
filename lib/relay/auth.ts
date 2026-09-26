// Who may read the relay's decision log and per-level spend.
//
// - The admin: RELAY_ADMIN_TOKEN as "Authorization: Bearer <token>", or the
//   session cookie set by signing in at /api/relay/admin (so the admin app's
//   same-origin fetches work without code changes).
// - An agent: its own kr1 token (x-api-key or Bearer), for its own name and
//   the names under it. The relay checks the signer owns the name on ENS.
// - Anyone, only in development without RELAY_ADMIN_TOKEN ("open").

import { createHash, timingSafeEqual } from "node:crypto";

import type { Address } from "viem";

import { tryNormalize } from "../ens/names";
import { applyDnsAlias } from "./config";
import { isChainReadError } from "./ens";
import { type PolicyDeps, REVOKED_ERROR, decide } from "./policy";
import { type RelayLimits, clientKey, isKnownGood, markKnownGood } from "./ratelimit";
import { TOKEN_PREFIX, TokenError, tokenFromHeaders, verifyToken } from "./token";
import type { RelayError } from "./types";

export const ADMIN_COOKIE = "relay_admin";

export type Viewer = { kind: "admin" } | { kind: "open" } | { kind: "agent"; name: string; signer: Address };

const NO_STORE = { "cache-control": "no-store" };

export const jsonError = (status: number, error: string, reason?: string, headers: Record<string, string> = {}) =>
  Response.json({ error, ...(reason ? { reason } : {}) } satisfies RelayError, { status, headers: { ...NO_STORE, ...headers } });

function cookieValue(headers: Headers, name: string): string | null {
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** True when the request carries the admin token or the admin session cookie. */
export function isAdmin(request: Request, deps: Pick<PolicyDeps, "config">): boolean {
  const { admin } = deps.config;
  if (!admin.enabled) return false;
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer && !bearer.startsWith(`${TOKEN_PREFIX}.`) && admin.check(bearer)) return true;
  const cookie = cookieValue(request.headers, ADMIN_COOKIE);
  const expected = admin.cookie();
  return !!cookie && !!expected && timingSafeEqual(digest(cookie), digest(expected));
}

const SIGN_IN = "Sign in at /api/relay/admin with RELAY_ADMIN_TOKEN, send it as Authorization: Bearer, or send an agent token for this name.";

/**
 * Works out who is asking. Returns a Response to send back when the request
 * may not read anything (no or bad credentials, rate limited, chain down).
 */
export async function viewerFor(request: Request, deps: PolicyDeps, limits: RelayLimits): Promise<Viewer | Response> {
  if (isAdmin(request, deps)) return { kind: "admin" };
  const token = tokenFromHeaders(request.headers);
  if (!token) {
    if (deps.config.viewAuth === "open") return { kind: "open" };
    const how = deps.config.viewAuth === "closed" ? "Set RELAY_ADMIN_TOKEN on the relay to read everything, or send an agent token for this name." : SIGN_IN;
    return jsonError(401, "not signed in", how);
  }

  const client = clientKey(request.headers);
  let signer: Address;
  let name: string;
  try {
    const verified = await verifyToken(token, undefined, { maxTtlSec: deps.config.maxTokenTtlSec, audiences: deps.config.audiences });
    const normalized = tryNormalize(verified.payload.name);
    if (!normalized) throw new TokenError("token names an invalid ENS name");
    signer = verified.signer;
    name = applyDnsAlias(normalized, deps.config.dnsAlias);
    // Pairs that recently checked out skip the failure limit, never the ownership check.
    const pair = `${name}|${signer}`;
    const known = isKnownGood(limits, pair);
    if (!known && !limits.failures.has(client)) return jsonError(429, "too many failed requests", "Wait a minute and try again.", { "retry-after": "60" });
    const d = await decide({ name, provider: null, signer }, deps);
    // With no provider, a chain that checks out ends in "unknown-provider".
    if (d.denial !== "unknown-provider") {
      if (!known) limits.failures.spend(client);
      if (d.denial === "not-registered") return jsonError(403, REVOKED_ERROR, d.reason ?? REVOKED_ERROR);
      return jsonError(401, "not the owner", d.reason ?? "the token's signer doesn't own its name");
    }
    const leaf = d.levels[d.levels.length - 1];
    if (leaf?.nbf && verified.payload.iat < leaf.nbf) {
      return jsonError(401, "token revoked", `tokens for ${name} issued before ${new Date(leaf.nbf * 1000).toISOString()} are refused`);
    }
    markKnownGood(limits, pair);
  } catch (err) {
    if (isChainReadError(err)) return jsonError(502, "ENS read failed", err.message);
    limits.failures.spend(client);
    return jsonError(401, "bad token", err instanceof TokenError ? err.message : "bad token");
  }
  return { kind: "agent", name, signer };
}

/** True when `viewer` may see data about `name` (an agent sees its own name and the names under it). */
export function canView(viewer: Viewer, name: string | null): boolean {
  if (viewer.kind !== "agent") return true;
  return !!name && (name === viewer.name || name.endsWith(`.${viewer.name}`));
}
