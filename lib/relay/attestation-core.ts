// "View attestation": the statement the relay binds into a TDX quote, and the
// pure helpers to check it. Browser-safe (viem's sha256 only), so the admin UI
// can re-check the binding itself.
//
// The relay builds a statement (no secrets): its URL, company root, pinned
// owner, which catalog APIs have a key, build id, issue time and an optional
// caller nonce. reportData (64 bytes) = sha256(canonicalJson(statement)) ‖ nonce
// (the nonce's bytes, zero-padded to 32; all zeros without one). The quote's
// REPORTDATA field must equal it.
//
// With RELAY_ATTESTATION_URL the quote comes from a separate attestation
// service in a dstack CVM (Phala Cloud) instead: the caller's nonce goes into
// REPORTDATA as is, and the quote covers that service (its compose hash is in
// MRCONFIGID), not the relay (RemoteAttestationResponse below).
//
// All hex strings here are lowercase without 0x, like dstack's.

import { sha256 } from "viem";

/** Phala's TEE Attestation Explorer: paste the quote hex (or upload the binary) to verify it. */
export const PHALA_VERIFY_URL = "https://proof.t16z.com/";

/** Phala's public verifier API: checks a quote's Intel signature, certificate chain and TCB collateral. */
export const PHALA_VERIFY_API = "https://cloud-api.phala.network/api/v1/attestations/verify";

/** The explorer page for a quote the verifier has seen (by its checksum). */
export const phalaReportUrl = (checksum: string) => `${PHALA_VERIFY_URL}reports/${checksum}`;

export type AttestationStatement = {
  v: 1;
  /** The relay base URL agents use, e.g. "http://127.0.0.1:3000/api/relay". */
  relay: string;
  /** RELAY_ROOT_NAME, or null. */
  root: string | null;
  /** RELAY_ROOT_OWNER (the address the relay accepts as the root's owner), or null when not pinned. */
  rootOwner: string | null;
  /** Every catalog API and whether the relay has what it needs to call it. */
  services: { id: string; configured: boolean }[];
  /** RELAY_BUILD_ID, or null. */
  build: string | null;
  /** ISO 8601. */
  issuedAt: string;
  /** The caller's nonce (hex), or null. */
  nonce: string | null;
};

/** Fields read from a TDX quote (v4, or v5 with a TD 1.0 / 1.5 body). */
export type TdxMeasurements = {
  version: number;
  /** "TDX" (0x81) or "SGX" (0x00); anything else as hex. */
  teeType: string;
  mrSeam: string;
  mrtd: string;
  /** 48 bytes. dstack sets it to 0x01 ‖ the app's compose hash (32 bytes) ‖ zero padding. */
  mrConfigId: string;
  rtmr0: string;
  rtmr1: string;
  rtmr2: string;
  rtmr3: string;
  tdAttributes: string;
  xfam: string;
  /** 64 bytes. */
  reportData: string;
};

/** A subset of dstack's info() (never keys or certificates). */
export type AttestationInfo = {
  appId?: string;
  instanceId?: string;
  appName?: string;
  composeHash?: string;
  osImageHash?: string;
  deviceId?: string;
};

/** GET /api/relay/attestation */
export type AttestationResponse = {
  statement: AttestationStatement;
  /** sha256(canonicalJson(statement)), 32 bytes. */
  statementHash: string;
  /** The 64 bytes passed to getQuote. */
  reportData: string;
  /** The TDX quote. */
  quote: string;
  /** dstack's event log (parsed JSON), or null. */
  eventLog: unknown[] | null;
  /** "simulator" when DSTACK_SIMULATOR_ENDPOINT is set (the quote is not from TEE hardware). */
  source: "simulator" | "tee";
  info?: AttestationInfo;
  verifyUrl: string;
  /** Parsed from the quote, or null when it isn't a TDX quote this parser knows. */
  measurements: TdxMeasurements | null;
};

/** Phala's public verifier on one quote. */
export type IntelVerification = {
  /** Intel's signature, certificate chain and TCB collateral all check out, for this exact quote. */
  verified: boolean;
  /** The verifier's id for the quote (its explorer page), or null. */
  checksum: string | null;
  reportUrl: string | null;
  /** ISO 8601, from the verifier. */
  verifiedAt: string | null;
  /** Why it isn't verified (the verifier said no, or didn't answer). */
  error?: string;
};

/** GET /api/relay/attestation when RELAY_ATTESTATION_URL is set: a quote from the attestation service. */
export type RemoteAttestationResponse = {
  source: "remote";
  /** The attestation service, as its own /info describes it (only composeHash is checked against the quote). */
  service: { url: string; appId?: string; instanceId?: string; composeHash?: string; osImageHash?: string; image?: string };
  /** The nonce that went into REPORTDATA (hex, 1–64 bytes). */
  nonce: string;
  quote: string;
  measurements: TdxMeasurements | null;
  /** null when the verifier wasn't asked. */
  intel: IntelVerification | null;
  verifyUrl: string;
  /** ISO 8601: when the relay fetched the quote. */
  fetchedAt: string;
};

export type RemoteChecks = {
  /** The bytes parse as a TDX quote. */
  tdx: boolean;
  /** REPORTDATA starts with the nonce (the rest is zero padding): the quote was made for this request. */
  nonceInQuote: boolean;
  /** MRCONFIGID is 0x01 ‖ the service's compose hash; null when the service didn't report one. */
  composeHashInQuote: boolean | null;
};

/** The MRCONFIGID dstack sets for a compose hash (hex, no 0x). */
export const mrConfigIdFor = (composeHash: string) => `01${strip0x(composeHash)}`.padEnd(96, "0");

/** What the quote bytes themselves show about a remote attestation (the browser runs this too). */
export function remoteChecks(quoteHex: string, nonce: string, composeHash: string | null | undefined): RemoteChecks {
  const m = parseTdxQuote(quoteHex);
  const n = strip0x(nonce);
  return {
    tdx: !!m,
    nonceInQuote: !!m && !!n && m.reportData === n.padEnd(128, "0"),
    composeHashInQuote: !composeHash ? null : !!m && m.mrConfigId === mrConfigIdFor(composeHash),
  };
}

/** 503 body when no dstack endpoint answers. */
export type AttestationUnavailable = { error: string; reason: "no-tee"; hint: string; detail?: string };

// --- Canonical JSON ------------------------------------------------------------------------------

/**
 * Deterministic JSON: object keys sorted (by UTF-16 code unit, as JCS),
 * undefined members dropped, no whitespace. Only plain data is accepted.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson: numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  throw new TypeError(`canonicalJson: can't encode ${typeof value}`);
}

// --- Hex --------------------------------------------------------------------------------------------

export const strip0x = (hex: string) => (hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex).toLowerCase();

export function fromHex(hex: string): Uint8Array {
  const h = strip0x(hex);
  if (h.length % 2 || !/^[0-9a-f]*$/.test(h)) throw new Error("not hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// --- Statement binding ---------------------------------------------------------------------------------

export function statementHash(statement: AttestationStatement): string {
  return strip0x(sha256(new TextEncoder().encode(canonicalJson(statement))));
}

/** A caller nonce: 1–32 bytes of hex (0x optional), lowercased; null when empty. Throws on anything else. */
export function parseNonce(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  const h = strip0x(v);
  if (!/^[0-9a-f]+$/.test(h) || h.length % 2 || h.length > 64) throw new Error("nonce must be 1–32 bytes of hex");
  return h;
}

/** sha256(statement) ‖ nonce zero-padded to 32 bytes: the 64 bytes the quote carries. */
export function reportDataFor(hash: string, nonce: string | null): string {
  const h = strip0x(hash);
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("statement hash must be 32 bytes");
  return h + (nonce ?? "").padEnd(64, "0");
}

// --- TDX quote ------------------------------------------------------------------------------------------

const HEADER = 48;
const TD_BODY = 584;

/**
 * Reads the TD report body of a TDX quote: v4 (body right after the 48-byte
 * header) or v5 (a 6-byte body descriptor first; TD 1.0 and 1.5 bodies share
 * these offsets). Null when the bytes aren't a TDX quote.
 */
export function parseTdxQuote(quoteHex: string): TdxMeasurements | null {
  let q: Uint8Array;
  try {
    q = fromHex(quoteHex);
  } catch {
    return null;
  }
  if (q.length < HEADER + TD_BODY) return null;
  const u16 = (o: number) => q[o] | (q[o + 1] << 8);
  const u32 = (o: number) => (q[o] | (q[o + 1] << 8) | (q[o + 2] << 16) | (q[o + 3] << 24)) >>> 0;
  const version = u16(0);
  const tee = u32(4);
  let body: number;
  if (version === 4) body = HEADER;
  else if (version === 5) {
    const type = u16(HEADER);
    if (type !== 2 && type !== 3) return null;
    body = HEADER + 6;
  } else return null;
  if (tee !== 0x81 || q.length < body + TD_BODY) return null;
  const f = (o: number, n: number) => toHex(q.subarray(body + o, body + o + n));
  return {
    version,
    teeType: "TDX",
    mrSeam: f(16, 48),
    tdAttributes: f(120, 8),
    xfam: f(128, 8),
    mrtd: f(136, 48),
    mrConfigId: f(184, 48),
    rtmr0: f(328, 48),
    rtmr1: f(376, 48),
    rtmr2: f(424, 48),
    rtmr3: f(472, 48),
    reportData: f(520, 64),
  };
}

export type Binding = {
  statementHash: string;
  /** REPORTDATA read from the quote, or null when it can't be parsed. */
  quoteReportData: string | null;
  /** The quote's REPORTDATA starts with sha256(statement). */
  bound: boolean;
  /** The second half equals the statement's nonce (zero-padded); true when there is no nonce and it is all zeros. */
  nonceBound: boolean;
};

/** Checks that a quote carries this statement (what the UI shows as "Statement bound to quote"). */
export function checkBinding(statement: AttestationStatement, quoteHex: string): Binding {
  const hash = statementHash(statement);
  const parsed = parseTdxQuote(quoteHex);
  const rd = parsed?.reportData ?? null;
  return {
    statementHash: hash,
    quoteReportData: rd,
    bound: !!rd && rd.slice(0, 64) === hash,
    nonceBound: !!rd && rd.slice(64) === (statement.nonce ?? "").padEnd(64, "0"),
  };
}
