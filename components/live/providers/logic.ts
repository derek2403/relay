// Pure helpers for the live Providers view: status pills, brand marks, credential display,
// and the attestation checks (canonical statement hash, TDX quote parsing). No React, no DOM.

import { sha256 } from "viem";

import { providerMark } from "@/lib/provider-marks";
import { canonicalJson, parseTdxQuote, statementHash } from "@/lib/relay/attestation-core";
import { CATALOG, CATEGORY_LABELS, type CatalogEntry, type Category } from "@/lib/relay/catalog";
import type { AttestationStatement, CredentialKeyView, CredentialsResponse, Measurements } from "./api";

// --- Catalog cards -----------------------------------------------------------------

/** Icon key for <Icon/>: a brand mark from lib/provider-marks, or a stroke icon from lib/icons. */
export const markFor = providerMark;

export type PillTone = "live" | "ok" | "idle" | "builtin" | "stored";
export type Pill = { text: string; tone: PillTone };

/** The relay answers it itself (the test API): no key and no upstream. */
export const isBuiltIn = (entry: Pick<CatalogEntry, "keyEnv" | "upstream">) => !entry.keyEnv && entry.upstream === null;

/** A public API the relay would forward to without any key. None in the catalog today: weather (OpenWeatherMap) has one. */
export const isKeyless = (entry: Pick<CatalogEntry, "keyEnv" | "upstream">) => !entry.keyEnv && entry.upstream !== null;

/** "api.openweathermap.org" for display; the raw value if it isn't a URL. */
export function upstreamHost(upstream: string | null): string {
  if (!upstream) return "";
  try {
    return new URL(upstream).host;
  } catch {
    return upstream;
  }
}

/**
 * Status pill for a catalog API. Every catalog API is routed by the relay; the pill says
 * whether it has a key. Codex is the relay's main API, so a configured Codex reads "Live".
 */
export function statusPill(entry: Pick<CatalogEntry, "id" | "keyEnv" | "upstream">, configured: boolean | undefined): Pill {
  if (isKeyless(entry)) return { text: "No key needed · routed", tone: "ok" };
  if (!entry.keyEnv) return { text: "Built in · no key needed", tone: "builtin" };
  if (configured === undefined) return { text: "Checking…", tone: "idle" };
  if (!configured) return { text: "Routed · no key", tone: "idle" };
  return entry.id === "codex" ? { text: "Live · routed", tone: "live" } : { text: "Routed · key set", tone: "ok" };
}

/** Pill for a custom, credential-only service. */
export function customPill(set: boolean): Pill {
  return set ? { text: "Stored · not routed", tone: "stored" } : { text: "No credentials", tone: "idle" };
}

export type CatalogGroup = { category: Category; label: string; entries: CatalogEntry[] };

/** Catalog entries grouped by category, in CATEGORY_LABELS order. */
export function groupCatalog(entries: readonly CatalogEntry[] = CATALOG): CatalogGroup[] {
  return (Object.keys(CATEGORY_LABELS) as Category[])
    .map((category) => ({ category, label: CATEGORY_LABELS[category], entries: entries.filter((e) => e.category === category) }))
    .filter((group) => group.entries.length > 0);
}

/** Labels of the other catalog APIs that read the same key env ("OPENAI_API_KEY" → Codex and OpenAI Images). */
export function sharedWith(entry: Pick<CatalogEntry, "id" | "keyEnv">, entries: readonly CatalogEntry[] = CATALOG): string[] {
  if (!entry.keyEnv) return [];
  return entries.filter((e) => e.id !== entry.id && e.keyEnv === entry.keyEnv).map((e) => e.label);
}

/**
 * The credential rows that belong to a catalog API: its key env plus any non-secret upstream
 * override the server lists for it. Falls back to the catalog's key env when the server has
 * no row for it yet (credentials API missing or still loading).
 */
export function keysFor(entry: Pick<CatalogEntry, "id" | "keyEnv" | "label">, keys: readonly CredentialKeyView[] | undefined): CredentialKeyView[] {
  const rows = (keys ?? []).filter((k) => k.apis.includes(entry.id) || k.env === entry.keyEnv);
  if (entry.keyEnv && !rows.some((k) => k.env === entry.keyEnv)) {
    rows.unshift({ env: entry.keyEnv, label: `${entry.label} key`, apis: [entry.id], secret: true, kind: "key", placeholder: "", set: false, source: null, updatedAt: null, hint: null });
  }
  // Secrets first, then plain settings (upstream URLs).
  return rows.sort((a, b) => Number(isSecret(b)) - Number(isSecret(a)));
}

/** Only rows the relay marks `secret: false` (upstream URLs) are plain settings. */
export const isSecret = (key: Pick<CredentialKeyView, "secret">) => key.secret !== false;

/** The relay can show hints and accept writes only for a signed-in owner or the admin cookie. */
export const canManage = (creds: Pick<CredentialsResponse, "owner" | "admin"> | undefined) => !!creds && (!!creds.owner || creds.admin);

// --- Credential display ----------------------------------------------------------------

/** What to show for a key: the redacted hint (owner only), "Set" or "Not set". Never a secret. */
export function secretDisplay(key: Pick<CredentialKeyView, "set" | "hint" | "secret" | "value">, authorized: boolean): string {
  if (!key.set) return "Not set";
  if (!isSecret(key)) return authorized && key.value ? key.value : "Set";
  return authorized && key.hint ? key.hint : "Set";
}

/** "stored on the relay" / "from the relay's environment" / "". */
export function sourceText(source: CredentialKeyView["source"]): string {
  if (source === "store") return "Stored on the relay";
  if (source === "env") return "Relay environment";
  return "";
}

/** Deterministic (server and browser agree) UTC timestamp: "2026-09-26 21:50 UTC". Accepts seconds or ms. */
export function formatUpdated(at: number | null | undefined): string {
  if (!at) return "Never";
  const ms = at < 1e12 ? at * 1000 : at;
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export type FieldChange = { env: string; action: "put"; value: string } | { env: string; action: "delete" };

/**
 * Writes for the edit dialog. `inputs` holds only fields the owner typed in.
 * Secrets: empty input keeps the stored value, "Clear" deletes it.
 * Plain settings: a field the owner never touched sends nothing (its value may only arrive
 * after sign-in); an edited one holds the full value, so emptying it clears the setting.
 */
export function planChanges(
  keys: readonly Pick<CredentialKeyView, "env" | "secret" | "value" | "set">[],
  inputs: Readonly<Record<string, string>>,
  cleared: ReadonlySet<string>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const key of keys) {
    const touched = Object.hasOwn(inputs, key.env);
    const input = (touched ? inputs[key.env] : "").trim();
    if (isSecret(key)) {
      if (cleared.has(key.env)) {
        if (key.set) changes.push({ env: key.env, action: "delete" });
      } else if (input) changes.push({ env: key.env, action: "put", value: input });
    } else {
      const current = key.value ?? "";
      if (!touched && !cleared.has(key.env)) continue;
      if (cleared.has(key.env) || (input === "" && current !== "")) {
        if (key.set) changes.push({ env: key.env, action: "delete" });
      } else if (input && input !== current) changes.push({ env: key.env, action: "put", value: input });
    }
  }
  return changes;
}

/** What an edit-dialog field shows: what the owner typed, else a plain setting's current value (never a secret). */
export const fieldValue = (key: Pick<CredentialKeyView, "env" | "secret" | "value">, inputs: Readonly<Record<string, string>>) =>
  Object.hasOwn(inputs, key.env) ? inputs[key.env] : isSecret(key) ? "" : (key.value ?? "");

/** Final text to sign: the server may send a "{address}" placeholder instead of taking ?address=. */
export const messageFor = (message: string, address: string) => message.split("{address}").join(address);

export const shortAddress = (address: string) => (address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address);

// --- Attestation -------------------------------------------------------------------

/**
 * Canonical JSON and TDX quote parsing come from the relay's own browser-safe module, so the
 * browser checks the statement with exactly the encoding the relay hashed.
 */
export { canonicalJson };

export const strip0x = (hex: string) => (hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex).toLowerCase();

export function hexToBytes(hex: string): Uint8Array {
  const clean = strip0x(hex.trim());
  if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) throw new Error("Not hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const bytesToHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * SHA-256 of a UTF-8 string, lowercase hex without 0x. viem's hash, not WebCrypto: browsers only
 * expose crypto.subtle on https or localhost, and the relay may be served over plain http.
 */
export const sha256Hex = (text: string): string => strip0x(sha256(new TextEncoder().encode(text)));

// Quote header (Intel TDX DCAP): version (u16) and TEE type (u32) in the first 48 bytes.
const HEADER = 48;
const TEE_TDX = 0x81;
const TEE_SGX = 0x00;

export type ParsedQuote = { version: number; teeType: "TDX" | "SGX" | "Unknown"; measurements: Measurements | null };

/** Reads the header and, for a TDX quote, MRTD, RTMR0-3 and the 64-byte report data. Null if it isn't a quote. */
export function parseQuote(hex: string | null | undefined): ParsedQuote | null {
  if (!hex) return null;
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(hex);
  } catch {
    return null;
  }
  if (bytes.length < HEADER) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(0, true);
  const tee = view.getUint32(4, true);
  const teeType = tee === TEE_TDX ? "TDX" : tee === TEE_SGX ? "SGX" : "Unknown";
  // v4 and v5 bodies (the relay's parser), so the check reads REPORTDATA where the relay put it.
  const tdx = teeType === "TDX" ? parseTdxQuote(bytesToHex(bytes)) : null;
  if (!tdx) return { version, teeType, measurements: null };
  const { mrtd, rtmr0, rtmr1, rtmr2, rtmr3, reportData } = tdx;
  return { version, teeType, measurements: { mrtd, rtmr0, rtmr1, rtmr2, rtmr3, reportData } };
}

export type BindingCheck = {
  /** sha256 of the canonical statement, as computed in this browser. */
  computed: string;
  /** Report data read from the quote in this browser, else what the relay says it is (not checked). */
  quoteReportData: string | null;
  /** True only when this browser parsed the quote and its report data starts with the computed hash. */
  bound: boolean;
  /** The server's statementHash agrees with the computed one (null when it sent none). */
  hashMatchesServer: boolean | null;
  /**
   * "quote": parsed from the quote here, so `bound` is a real check. "server": the quote couldn't be
   * parsed, so only the relay's own reportData/measurements are known and nothing is proven.
   */
  reportDataFrom: "quote" | "server" | null;
};

/**
 * The statement is bound to the quote when sha256(canonicalJson(statement)) is the first 32
 * bytes of the report data inside the quote (the rest is the optional nonce or zero padding).
 * Only a quote parsed here counts: report data the relay sends alongside is its own claim.
 */
export function checkBinding(input: {
  statement: AttestationStatement | Record<string, unknown>;
  statementHash?: string | null;
  reportData?: string | null;
  quote?: string | null;
  measurements?: Measurements | null;
}): BindingCheck {
  // The relay's own hashing code (viem sha256 over canonical JSON), so both sides agree byte for byte.
  const computed = statementHash(input.statement as Parameters<typeof statementHash>[0]);
  const fromQuote = parseQuote(input.quote)?.measurements?.reportData ?? null;
  const claimed = input.measurements?.reportData ?? input.reportData ?? null;
  const reportData = fromQuote ? strip0x(fromQuote) : claimed ? strip0x(claimed) : null;
  return {
    computed,
    quoteReportData: reportData,
    bound: !!fromQuote && strip0x(fromQuote).startsWith(computed),
    hashMatchesServer: input.statementHash ? strip0x(input.statementHash) === computed : null,
    reportDataFrom: fromQuote ? "quote" : reportData ? "server" : null,
  };
}

/** Honest label for where the quote came from. */
export const sourceLabel = (source: string | undefined) => (source === "tee" ? "TDX hardware" : source === "simulator" ? "dstack simulator" : "Unknown source");

/** Phala's TEE Attestation Explorer; the server may send a deep link instead. */
export const PHALA_EXPLORER = "https://proof.t16z.com/";
