// Agent access tokens.
//
// An agent never holds a provider key. Instead its own key signs a small token
// naming the ENS name it acts as. Tools pass the token wherever they'd pass an
// API key (x-api-key for the Anthropic SDK, "Authorization: Bearer" for OpenAI,
// GitHub, Railway), so Claude Code or Codex work by pointing their base URL at
// the relay. On every request the relay recovers the signer and checks it
// still owns the name on ENS, so revoking the name revokes the token.
//
// Format: kr1.<base64url(JSON payload)>.<signature hex>
// The signature is EIP-191 (personal_sign) over "keyless-relay:v1:<payload b64>".

import { type Address, type Hex, isHex, recoverMessageAddress } from "viem";

export const TOKEN_PREFIX = "kr1";

/** Longest token lifetime a relay accepts unless configured otherwise (RELAY_MAX_TOKEN_TTL). */
export const DEFAULT_MAX_TOKEN_TTL_SEC = 24 * 3600;

export type TokenPayload = {
  v: 1;
  /** Normalized ENS name the agent acts as. */
  name: string;
  /** Issued at, unix seconds. */
  iat: number;
  /** Expires at, unix seconds. Set it no later than the name's expiry. */
  exp: number;
  /** Optional audience: the origin of the relay the token is for (e.g. "https://relay.acme.com"). */
  aud?: string;
};

type Signer = { signMessage: (args: { message: string }) => Promise<Hex> };

const toB64Url = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromB64Url = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

export const tokenMessage = (payloadB64: string) => `keyless-relay:v1:${payloadB64}`;

/** Signs a token with the agent's key (a viem LocalAccount or anything with signMessage). */
export async function createToken(signer: Signer, payload: Omit<TokenPayload, "v">): Promise<string> {
  const body = toB64Url(JSON.stringify({ v: 1, ...payload } satisfies TokenPayload));
  const signature = await signer.signMessage({ message: tokenMessage(body) });
  return `${TOKEN_PREFIX}.${body}.${signature}`;
}

export class TokenError extends Error {}

/** Parses a token without verifying it. Throws TokenError on malformed input. */
export function parseToken(token: string): { payload: TokenPayload; body: string; signature: Hex } {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) throw new TokenError("not a Keyless Relay token");
  const [, body, signature] = parts;
  if (!isHex(signature)) throw new TokenError("bad token signature");
  let payload: TokenPayload;
  try {
    payload = JSON.parse(fromB64Url(body));
  } catch {
    throw new TokenError("bad token payload");
  }
  if (
    payload?.v !== 1 ||
    typeof payload.name !== "string" ||
    typeof payload.exp !== "number" ||
    typeof payload.iat !== "number" ||
    (payload.aud !== undefined && typeof payload.aud !== "string")
  ) {
    throw new TokenError("bad token payload");
  }
  return { payload, body, signature };
}

export type VerifyOptions = {
  /** Reject tokens whose lifetime (exp - iat) is longer than this. */
  maxTtlSec?: number;
  /** Accepted audiences. A token that names an audience must match one; a token without one is accepted. */
  audiences?: string[];
};

/**
 * Verifies the signature, expiry and (with options) lifetime and audience,
 * and returns who signed it. Does NOT check ENS: the caller must still
 * confirm `signer` owns `payload.name` right now.
 */
export async function verifyToken(
  token: string,
  nowSec = Math.floor(Date.now() / 1000),
  opts: VerifyOptions = {},
): Promise<{ payload: TokenPayload; signer: Address }> {
  const { payload, body, signature } = parseToken(token);
  if (payload.exp <= nowSec) throw new TokenError("token expired");
  if (payload.iat > nowSec + 300) throw new TokenError("token issued in the future");
  if (opts.maxTtlSec !== undefined && payload.exp - payload.iat > opts.maxTtlSec) {
    throw new TokenError(`token lifetime is longer than this relay allows (${Math.round(opts.maxTtlSec / 3600)} h); sign a shorter one`);
  }
  if (opts.audiences && payload.aud !== undefined && !opts.audiences.includes(payload.aud.replace(/\/+$/, ""))) {
    throw new TokenError(`token is for ${payload.aud}, not this relay`);
  }
  let signer: Address;
  try {
    signer = await recoverMessageAddress({ message: tokenMessage(body), signature });
  } catch {
    throw new TokenError("bad token signature");
  }
  return { payload, signer };
}

/** Pulls a token from the headers tools use for API keys. */
export function tokenFromHeaders(headers: Headers): string | null {
  const apiKey = headers.get("x-api-key");
  if (apiKey?.startsWith(`${TOKEN_PREFIX}.`)) return apiKey.trim();
  const auth = headers.get("authorization");
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer?.startsWith(`${TOKEN_PREFIX}.`)) return bearer;
  return null;
}
