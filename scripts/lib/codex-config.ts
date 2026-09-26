// Plain `codex` through the relay: `relay login` points Codex's config.toml (CODEX_HOME, default ~/.codex)
// at a "relay" model provider, and `relay logout` puts the file back the way it was.
//
// Two ways to sign in:
// - A Codex login (the default): base_url is <relay>/api/relay/codex/login/v1 and http_headers sends the
//   secret of a login the relay holds (lib/relay/codex-login.ts); `requires_openai_auth = true` makes
//   Codex show its own login screen. The user picks "Provide your own API key" and types their ENS name; Codex stores it in
//   auth.json and sends it as the Bearer value, which the relay checks against the login. Because Codex
//   would send any sign-in in auth.json (a ChatGPT token too) to that base_url, the user's own auth.json
//   is moved aside at login and put back, byte for byte, at logout. For the same reason the login also sets
//   `forced_login_method = "api"` (the login screen can't start a ChatGPT sign-in) and
//   `cli_auth_credentials_store = "file"` (a sign-in in the OS keyring is neither sent nor overwritten).
// - An auth command (`relay login --auth-command`): Codex runs it whenever it needs a token (and every
//   refresh interval), so the ENS-signed token is always fresh and never stored in the config. auth.json
//   is not touched.
// Codex 0.155 dropped the top-level `profile = …` default, so the relay is selected with the top-level
// `model_provider` and `model` keys; the user's own values for them are kept as comments and restored on
// logout. `[notice] hide_rate_limit_model_nudge = true` stops Codex offering another model when the ENS cap
// is nearly spent (the relay sends Codex's usage headers, lib/relay/codex-limits.ts). `model_catalog_json`
// points at a catalog with the relay's model in it (relayModelCatalog): Codex only fetches model metadata
// for ChatGPT sign-ins, and warns "Model metadata … not found" without it.
//
// The config functions are pure text in, text out; the auth.json helpers at the end do their own file I/O.

import fs from "node:fs";
import path from "node:path";

import { tryNormalize } from "../../lib/ens/names";
import { CODEX_LOGIN_HEADER, codexLoginBaseUrl } from "../../lib/relay/codex-login";

export const CODEX_PROVIDER_ID = "relay";
export const DEFAULT_CODEX_MODEL = "gpt-5.3-codex";
/** How often Codex re-runs the auth command (tokens it gets live 15 minutes). */
export const CODEX_TOKEN_REFRESH_MS = 4 * 60_000;

const BLOCK_START = "# >>> relay: written by `relay login`; `relay logout` removes it";
const BLOCK_END = "# <<< relay";
/** Suffix on the top-level keys `relay login` adds. */
const OURS = " # relay login";
/** Prefix on the user's own top-level keys it set aside. */
const SAVED = "# relay login saved: ";
/** Top-level keys that choose the provider and model; the user's are set aside while logged in. */
const TOP_KEYS = ["model_provider", "model"];
/**
 * Top-level keys a Codex login also sets (the user's set aside the same way): only an API-key sign-in
 * (ChatGPT's would send its token to the relay), kept in auth.json (a keyring sign-in would be sent too,
 * and typing the name would overwrite it).
 */
const LOGIN_KEYS: [string, string][] = [
  ["forced_login_method", "api"],
  ["cli_auth_credentials_store", "file"],
];
/** The top-level key for the relay's model catalog (the user's own set aside the same way). */
const CATALOG_KEY = "model_catalog_json";
/** The key `relay login` adds to a [notice] table the user already has. */
const NUDGE_KEY = "hide_rate_limit_model_nudge";
const OUR_KEYS = [...TOP_KEYS, ...LOGIN_KEYS.map(([k]) => k), CATALOG_KEY, NUDGE_KEY];
const topKey = (line: string) => line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1] ?? null;
const NOTICE_HEADER = /^\s*\[\s*notice\s*\]\s*(#.*)?$/;

export type RelayCodexOptions = {
  /** The agent's ENS name, shown as the provider's name in Codex. */
  agent: string;
  /** The relay origin, e.g. https://relay.derek2403.win. */
  relayUrl: string;
  model: string;
  /** Absolute path of a model catalog with `model` in it (relayModelCatalog); none: Codex warns it has no metadata. */
  modelCatalog?: string | null;
} & (
  | {
      /** The secret of a Codex login registered with the relay: Codex shows its login screen. */
      loginSecret: string;
      authCommand?: undefined;
    }
  | {
      /** Absolute path of an executable that prints a fresh token (no arguments). */
      authCommand: string;
      loginSecret?: undefined;
    }
);

export type CodexConfigResult = { text: string };

/** TOML basic string (JSON escapes are valid TOML escapes for the characters that can appear here). */
const tomlString = (s: string) => JSON.stringify(s);

/** A table header line's name without spaces, e.g. `model_providers.relay`; null for other lines. */
const tableName = (line: string) => line.match(/^\s*\[([^[\]]*)\]\s*(#.*)?$/)?.[1].replace(/\s+/g, "") ?? null;
const PROVIDER_TABLES = [`model_providers.${CODEX_PROVIDER_ID}`, `model_providers.${CODEX_PROVIDER_ID}.auth`];

/**
 * The file without anything `relay login` wrote, with the user's own keys put back. Codex itself adds
 * tables at the end of the file (a folder's trust, a dismissed notice), which puts them inside our block:
 * those, and keys Codex adds to our [notice] table, are the user's and are kept.
 */
export function withoutRelayCodexConfig(text: string): string {
  const out: string[] = [];
  let inBlock = false;
  // Where our block ended in `out`, when no blank line of ours came before it: then the newline ending
  // the block is ours instead (the user's file had none at its end).
  let endedAt: number | null = null;
  // Inside the block: "ours" (a table we wrote), "notice" (our [notice]: only the nudge key is ours) or
  // "theirs" (a table Codex added); `header` is our [notice] header, until a key of theirs needs it.
  let table: "ours" | "notice" | "theirs" = "ours";
  let header: string | null = null;
  const keep = (line: string) => {
    // Codex's content starts a new paragraph after the user's text.
    if (out.length && out[out.length - 1] !== "" && tableName(line) !== null) out.push("");
    out.push(line);
  };
  for (const line of text.split("\n")) {
    if (line.trim() === BLOCK_START) {
      inBlock = true;
      table = "ours";
      // The blank line withRelayCodexConfig puts before the block is ours too.
      if (out.length && out[out.length - 1] === "") out.pop();
      else endedAt = out.length;
      continue;
    }
    if (inBlock) {
      if (line.trim() === BLOCK_END) {
        inBlock = false;
        continue;
      }
      const name = /^\s*\[/.test(line) ? (tableName(line) ?? "") : null;
      if (name !== null) {
        table = PROVIDER_TABLES.includes(name) ? "ours" : name === "notice" ? "notice" : "theirs";
        header = table === "notice" ? line : null;
        if (table === "theirs") keep(line);
        continue;
      }
      if (table === "theirs") out.push(line);
      else if (table === "notice" && line.trim() && !line.trim().startsWith("#") && topKey(line) !== NUDGE_KEY) {
        if (header !== null) keep(header);
        header = null;
        out.push(line);
      }
      continue;
    }
    if (line.endsWith(OURS) && OUR_KEYS.includes(topKey(line) ?? "")) continue;
    out.push(line.startsWith(SAVED) ? line.slice(SAVED.length) : line);
  }
  if (endedAt !== null && out.length === endedAt + 1 && out[endedAt] === "") out.pop();
  return out.join("\n");
}

/** Top-level keys come before the first [table]; returns the index of that first table line (or the end). */
function firstTableLine(lines: string[]): number {
  const i = lines.findIndex((l) => /^\s*\[/.test(l));
  return i < 0 ? lines.length : i;
}

/**
 * Tables `relay login` needs that the user already defines themselves (outside our block): writing ours
 * too would make the file invalid TOML, so the caller refuses instead.
 */
export function conflictingTables(text: string): string[] {
  const clean = withoutRelayCodexConfig(text);
  const wanted = [`model_providers.${CODEX_PROVIDER_ID}`, `model_providers.${CODEX_PROVIDER_ID}.auth`];
  return wanted.filter((t) => new RegExp(`^\\s*\\[\\s*${t.replace(/\./g, "\\s*\\.\\s*")}\\s*\\]`, "m").test(clean));
}

/**
 * Where `hide_rate_limit_model_nudge = true` goes: "block" (a [notice] table in our block), the index of
 * the user's own [notice] header to add it under, or null (they set it themselves, or define notice in a
 * way a second table would break).
 */
function nudgePlace(lines: string[]): "block" | number | null {
  const header = lines.findIndex((l) => NOTICE_HEADER.test(l));
  if (header < 0) {
    // `notice = {…}` or `notice.x = …` at the top level: a [notice] table would be a duplicate.
    const top = lines.slice(0, firstTableLine(lines));
    return top.some((l) => /^\s*notice\s*[.=]/.test(l)) ? null : "block";
  }
  for (let i = header + 1; i < lines.length && !/^\s*\[/.test(lines[i]); i++) if (topKey(lines[i]) === NUDGE_KEY) return null;
  return header;
}

export function withRelayCodexConfig(text: string, o: RelayCodexOptions): CodexConfigResult {
  const base = withoutRelayCodexConfig(text);
  const lines = base.length ? base.split("\n") : [];
  const nudge = nudgePlace(lines);
  if (typeof nudge === "number") lines.splice(nudge + 1, 0, `${NUDGE_KEY} = true${OURS}`);
  const firstTable = firstTableLine(lines);
  const login = o.loginSecret !== undefined ? LOGIN_KEYS : [];
  const catalog = o.modelCatalog ? [CATALOG_KEY] : [];
  const setAside = [...TOP_KEYS, ...login.map(([k]) => k), ...catalog];
  // The user's own values for the keys we set become comments (restored on logout); ours go first.
  const top = lines.slice(0, firstTable).map((l) => (setAside.includes(topKey(l) ?? "") ? `${SAVED}${l}` : l));
  const rest = lines.slice(firstTable);
  const ours = [
    `model_provider = "${CODEX_PROVIDER_ID}"${OURS}`,
    `model = ${tomlString(o.model)}${OURS}`,
    ...login.map(([k, v]) => `${k} = ${tomlString(v)}${OURS}`),
    ...(o.modelCatalog ? [`${CATALOG_KEY} = ${tomlString(o.modelCatalog)}${OURS}`] : []),
  ];
  const relay = o.relayUrl.replace(/\/+$/, "");
  const provider =
    o.loginSecret !== undefined
      ? [
          `base_url = ${tomlString(codexLoginBaseUrl(relay))}`,
          `wire_api = "responses"`,
          "requires_openai_auth = true",
          // In a header, not the URL: Codex prints the request URL in its error messages.
          `http_headers = { ${tomlString(CODEX_LOGIN_HEADER)} = ${tomlString(o.loginSecret)} }`,
        ]
      : [
          `base_url = ${tomlString(`${relay}/api/relay/codex/v1`)}`,
          `wire_api = "responses"`,
          "",
          `[model_providers.${CODEX_PROVIDER_ID}.auth]`,
          `command = ${tomlString(o.authCommand)}`,
          `refresh_interval_ms = ${CODEX_TOKEN_REFRESH_MS}`,
        ];
  const block = [
    BLOCK_START,
    `[model_providers.${CODEX_PROVIDER_ID}]`,
    `name = ${tomlString(`Keyless Relay (${o.agent})`)}`,
    ...provider,
    ...(nudge === "block" ? ["", "[notice]", `${NUDGE_KEY} = true`] : []),
    BLOCK_END,
  ].join("\n");
  // The user's text keeps its own trailing newlines, so removing our lines gives it back exactly: a blank
  // line of ours before the block, or (when the text had no newline at its end) none, and the newline
  // after the block is ours.
  const body = [...top, ...rest].join("\n");
  return { text: `${ours.join("\n")}\n${body ? `${body}\n` : ""}${block}\n` };
}

/** The bundled entry a relay model copies when Codex has none of its own (gpt-5.3-codex's family). */
const CATALOG_TEMPLATE = "gpt-5.4";

type CatalogEntry = Record<string, unknown> & { slug: string };

/**
 * The model catalog for `model_catalog_json`: `model` alone, from Codex's own bundled catalog (the
 * output of `codex debug models --bundled`). Its entry for the model when it has one, else a copy of
 * CATALOG_TEMPLATE's (else of the first the API supports) under the model's name, so no instructions
 * text is ours. Null when the output has no usable entry (each needs instructions, or Codex won't start).
 */
export function relayModelCatalog(bundled: string, model: string): string | null {
  let models: unknown;
  try {
    models = (JSON.parse(bundled) as { models?: unknown } | null)?.models;
  } catch {
    return null;
  }
  if (!Array.isArray(models)) return null;
  const hasInstructions = (m: CatalogEntry) => {
    const messages = m.model_messages as { instructions_template?: unknown } | null | undefined;
    return typeof m.base_instructions === "string" || typeof messages?.instructions_template === "string";
  };
  const entries = models.filter((m): m is CatalogEntry => !!m && typeof m === "object" && typeof (m as { slug?: unknown }).slug === "string").filter(hasInstructions);
  const own = entries.find((m) => m.slug === model);
  if (own) return `${JSON.stringify({ models: [own] }, null, 2)}\n`;
  const template = entries.find((m) => m.slug === CATALOG_TEMPLATE) ?? entries.find((m) => m.supported_in_api === true);
  if (!template) return null;
  const entry = { ...template, slug: model, display_name: model, description: "Through Keyless Relay", visibility: "list", upgrade: null, availability_nux: null };
  return `${JSON.stringify({ models: [entry] }, null, 2)}\n`;
}

/** The script Codex runs for a token: execs this CLI's `codex-token` for this RELAY_HOME (Codex's auth command takes no arguments). */
export function authScript(o: { node: string; cli: string; viaNode: boolean; relayHome: string }): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    "#!/bin/sh",
    "# Written by `relay login`: Codex runs this for a fresh relay token (relay codex-token).",
    `RELAY_HOME=${q(o.relayHome)} exec ${o.viaNode ? `${q(o.node)} ` : ""}${q(o.cli)} codex-token`,
    "",
  ].join("\n");
}

// --- auth.json ----------------------------------------------------------------------------------------

/** Where the user's own auth.json waits while a Codex login is set up. */
export const AUTH_BACKUP_SUFFIX = ".before-relay";

const authFiles = (codexHome: string) => {
  const auth = path.join(codexHome, "auth.json");
  return { auth, backup: `${auth}${AUTH_BACKUP_SUFFIX}` };
};

const readOrNull = (file: string) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
};

/**
 * True for the auth.json Codex writes when an ENS name is typed at its login screen: an API-key sign-in
 * whose "key" is a valid .eth name, or one of `known` (the names this CLI logs in with, which may be a
 * DNS alias). A name login is deleted without a backup, so nothing that could be a real key counts:
 * OpenAI keys (sk-…) have no dots, and a gateway's dotted JWT-style key isn't a .eth name.
 */
export function isNameLogin(text: string | null, known: readonly string[] = []): boolean {
  if (text === null) return false;
  try {
    const j = JSON.parse(text) as { auth_mode?: unknown; OPENAI_API_KEY?: unknown; tokens?: unknown };
    const key = typeof j.OPENAI_API_KEY === "string" ? j.OPENAI_API_KEY.trim() : "";
    if (j.auth_mode !== "apikey" || j.tokens || !key.includes(".") || /^(sk-|eyJ)/i.test(key)) return false;
    const name = tryNormalize(key);
    if (!name || name.split(".").some((label) => !label)) return false;
    return name.endsWith(".eth") || known.some((k) => tryNormalize(k) === name);
  } catch {
    return false;
  }
}

export type AuthAside =
  | { ok: true; action: "none" | "moved" | "removed-name-login" }
  | { ok: false; reason: string };

/** Whether moveAuthAside would work, without changing anything. */
export function checkAuthAside(codexHome: string, known: readonly string[] = []): AuthAside {
  const { auth, backup } = authFiles(codexHome);
  const text = readOrNull(auth);
  if (text === null) return { ok: true, action: "none" };
  if (isNameLogin(text, known)) return { ok: true, action: "removed-name-login" };
  if (fs.existsSync(backup)) return { ok: false, reason: `${auth} holds a Codex sign-in and ${backup} already exists; move one of them away, then run login again` };
  return { ok: true, action: "moved" };
}

/**
 * Moves the user's own auth.json to auth.json.before-relay (a rename: same bytes, same mode), so Codex
 * shows its login screen and never sends that sign-in to the relay. A name login from an earlier relay
 * login is deleted instead. Refuses (changing nothing) when a backup already exists.
 */
export function moveAuthAside(codexHome: string, known: readonly string[] = []): AuthAside {
  const check = checkAuthAside(codexHome, known);
  if (!check.ok || check.action === "none") return check;
  const { auth, backup } = authFiles(codexHome);
  if (check.action === "removed-name-login") fs.rmSync(auth, { force: true });
  else fs.renameSync(auth, backup);
  return check;
}

/**
 * Undoes moveAuthAside: the name login goes, the user's own auth.json comes back exactly. A sign-in the
 * user made in the meantime (not a name login) is kept, and so is the backup ("kept").
 */
export function restoreAuth(codexHome: string, known: readonly string[] = []): "restored" | "kept" | "removed-name-login" | "none" {
  const { auth, backup } = authFiles(codexHome);
  const current = readOrNull(auth);
  const nameLogin = isNameLogin(current, known);
  if (!fs.existsSync(backup)) {
    if (!nameLogin) return "none";
    fs.rmSync(auth, { force: true });
    return "removed-name-login";
  }
  if (current !== null && !nameLogin) return "kept";
  fs.rmSync(auth, { force: true });
  fs.renameSync(backup, auth);
  return "restored";
}
