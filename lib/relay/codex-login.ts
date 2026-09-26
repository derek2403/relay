// Codex logins: what lets plain `codex` sign in with an ENS name.
//
// `relay login` makes a random secret and puts it in Codex's config: the provider's base_url is
// <relay>/api/relay/codex/login/v1 and `http_headers` sends the secret as x-relay-login on every call
// (never in the URL: Codex prints request URLs in its errors, and proxies log them). The agent key (the
// owner of codex.<member>) signs a message binding sha256(secret) to the agent, its member, the relay
// and an expiry, and the CLI registers it at POST /api/relay/codex/sessions. In Codex the user then picks
// "Provide your own API key" and types their ENS name: Codex sends it as the Bearer value, and the relay
// serves the call as the agent only when the name matches the login (lib/relay/codex-sessions.ts). The
// secret never leaves the user's Codex config; the relay stores only its hash.
//
// Shared by the relay and the CLI: no server-only imports here.

import type { Hex } from "viem";
import { sha256, stringToBytes } from "viem";

/** Where the CLI registers (POST) and revokes (DELETE) a Codex login. */
export const CODEX_SESSIONS_PATH = "/api/relay/codex/sessions";
/** Codex's base_url for a login: <relay><CODEX_LOGIN_PATH>/v1, with the secret in CODEX_LOGIN_HEADER. */
export const CODEX_LOGIN_PATH = "/api/relay/codex/login";
export const CODEX_LOGIN_HEADER = "x-relay-login";
/** Longest a Codex login may last (and never past the agent's own ENS expiry). */
export const MAX_CODEX_LOGIN_SEC = 24 * 3600;
/** How far a signed registration's `issued` may be from the relay's clock. */
export const CODEX_LOGIN_SKEW_SEC = 300;

/** 32 random bytes, base64url: 43 characters. */
export const LOGIN_SECRET = /^[A-Za-z0-9_-]{43}$/;

export function newLoginSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

/** What the relay stores and the signature binds: sha256 of the secret's characters, lowercase 0x hex. */
export const loginSecretHash = (secret: string): Hex => sha256(stringToBytes(secret));

export const codexLoginBaseUrl = (relayUrl: string) => `${relayUrl.replace(/\/+$/, "")}${CODEX_LOGIN_PATH}/v1`;

export type CodexLoginClaim = {
  /** The agent the calls run as, e.g. codex.derek.cloudops.dev.sodalabs.eth. */
  agent: string;
  /** The name typed into Codex's login screen: the agent's member (or the agent name itself). */
  member: string;
  /** Origin of the relay the login is for. */
  relay: string;
  secretHash: Hex;
  /** Unix seconds. */
  iat: number;
  /** Unix seconds; at most MAX_CODEX_LOGIN_SEC after iat and never past the agent's ENS expiry. */
  exp: number;
};

/** The EIP-191 message the agent key signs to register a Codex login. */
export function codexLoginMessage(c: CodexLoginClaim): string {
  return [
    "Keyless Relay: sign in to Codex",
    `agent: ${c.agent}`,
    `member: ${c.member}`,
    `relay: ${c.relay}`,
    `secret: ${c.secretHash}`,
    `issued: ${c.iat}`,
    `expires: ${c.exp}`,
  ].join("\n");
}

export type CodexLogoutClaim = { relay: string; secretHash: Hex; iat: number };

/** The EIP-191 message the same key signs to revoke it. */
export function codexLogoutMessage(c: CodexLogoutClaim): string {
  return ["Keyless Relay: sign out of Codex", `relay: ${c.relay}`, `secret: ${c.secretHash}`, `issued: ${c.iat}`].join("\n");
}
