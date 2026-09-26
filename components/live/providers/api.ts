// Typed client for the relay's credentials and attestation API (design "Revised C-A" / "C-B").
// Same-origin fetches; cookies (relay_owner / admin) ride along automatically. Secrets only ever
// travel browser → relay in PUT bodies; no response carries one.

import { getJson, RelayApiError } from "@/lib/relay/browser";

// The server's published shapes (lib/relay/credentials-types.ts is pure and browser-safe).
export type {
  CredentialKeyView,
  CredentialsResponse,
  CustomServiceView,
  NonceResponse,
  OwnerSession,
  SessionResponse,
} from "@/lib/relay/credentials-types";
import type { CredentialKeyView, CredentialsResponse, CustomServiceView, NonceResponse, SessionResponse } from "@/lib/relay/credentials-types";

export type AttestationStatement = {
  v: number;
  relay: string;
  root: string | null;
  rootOwner: string | null;
  services: { id: string; configured: boolean }[];
  build: string | null;
  issuedAt: number | string;
  nonce: string | null;
  [key: string]: unknown;
};

/** Hex without 0x; reportData is the full 64 bytes. */
export type Measurements = { mrtd: string; rtmr0: string; rtmr1: string; rtmr2: string; rtmr3: string; reportData: string };

export type AttestationResponse = {
  statement: AttestationStatement;
  statementHash: string;
  reportData: string;
  quote: string;
  eventLog?: unknown;
  source: "simulator" | "tee";
  info?: Record<string, unknown> | null;
  verifyUrl?: string | null;
  measurements?: Measurements | null;
};

const BASE = "/api/relay/credentials";
const q = encodeURIComponent;

// Cookie-authenticated writes must be JSON, DELETE included (the relay's CSRF check refuses
// anything else with 415); the browser adds the same-origin Origin header itself.
const send = <T>(url: string, method: "POST" | "PUT" | "DELETE", body?: unknown) =>
  getJson<T>(url, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const credentialsApi = {
  list: () => getJson<CredentialsResponse>(BASE, { credentials: "same-origin" }),
  nonce: (address: string) => getJson<NonceResponse>(`${BASE}/nonce?address=${q(address)}`, { credentials: "same-origin" }),
  signIn: (address: string, message: string, signature: string) =>
    send<SessionResponse>(`${BASE}/session`, "POST", { address, message, signature }),
  signOut: () => send<unknown>(`${BASE}/session`, "POST", { action: "signout" }),
  putKey: (env: string, value: string | null) => send<CredentialKeyView>(`${BASE}/keys/${q(env)}`, "PUT", { value }),
  clearKey: (env: string) => send<CredentialKeyView>(`${BASE}/keys/${q(env)}`, "DELETE"),
  addCustom: (body: { label: string; value: string; note?: string }) => send<CustomServiceView>(`${BASE}/custom`, "PUT", body),
  putCustom: (id: string, body: { label?: string; value?: string | null; note?: string | null }) => send<CustomServiceView>(`${BASE}/custom/${q(id)}`, "PUT", body),
  clearCustom: (id: string) => send<unknown>(`${BASE}/custom/${q(id)}`, "DELETE"),
};

export const attestationApi = {
  get: (nonce?: string) => getJson<AttestationResponse>(`/api/relay/attestation${nonce ? `?nonce=${q(nonce)}` : ""}`),
};

export const statusOf = (err: unknown) => (err instanceof RelayApiError ? err.status : null);
export const reasonOf = (err: unknown) => (err instanceof RelayApiError ? err.reason ?? null : null);

/** getJson's message when a 404 had no JSON body ("/api/… not found"), i.e. no such route on this relay. */
const isMissingRoute = (err: unknown) => err instanceof RelayApiError && err.status === 404 && !err.reason && /^\/\S* not found$/.test(err.message);

/** Short khaki-toned text for an API failure. */
export function apiErrorText(err: unknown, what = "The relay"): string {
  const status = statusOf(err);
  const message = err instanceof Error ? err.message : String(err);
  const reason = reasonOf(err);
  const detail = reason && reason !== message ? `${message}: ${reason}` : message;
  if (status === 401) return detail || "Sign in as the owner first.";
  if (status === 403) return detail || "Not allowed from this page.";
  // A 404 without a JSON { error } is Next's own page: the route isn't there. The relay's
  // own 404s ("unknown service", "unknown key") say what's missing.
  if (status === 404) return isMissingRoute(err) ? `${what} has no credentials API yet.` : detail;
  if (status === 429) return detail || "Too many attempts. Try again in a minute.";
  if (status === 503) return detail || `${what} is not set up for this yet.`;
  return detail;
}
