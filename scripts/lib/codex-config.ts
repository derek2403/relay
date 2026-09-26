// Plain `codex` through the relay: `relay login` points Codex's config.toml (CODEX_HOME, default ~/.codex)
// at a "relay" model provider, and `relay logout` puts the file back the way it was.
//
// Codex runs the provider's auth command whenever it needs a token (and every refresh interval), so the
// ENS-signed token is always fresh and never stored in the config. Codex's own sign-in (auth.json) is
// never touched. Codex 0.155 dropped the top-level `profile = …` default, so the relay is selected with
// the top-level `model_provider` and `model` keys; the user's own values for them are kept as comments
// and restored on logout.
//
// Pure text in, text out; the caller does the file I/O.

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
const topKey = (line: string) => line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1] ?? null;

export type RelayCodexOptions = {
  /** The agent's ENS name, shown as the provider's name in Codex. */
  agent: string;
  /** The relay origin, e.g. https://relay.derek2403.win. */
  relayUrl: string;
  /** Absolute path of an executable that prints a fresh token (no arguments). */
  authCommand: string;
  model: string;
};

export type CodexConfigResult = { text: string };

/** TOML basic string (JSON escapes are valid TOML escapes for the characters that can appear here). */
const tomlString = (s: string) => JSON.stringify(s);

/** The file without anything `relay login` wrote, with the user's own keys put back. */
export function withoutRelayCodexConfig(text: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of text.split("\n")) {
    if (line.trim() === BLOCK_START) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (line.trim() === BLOCK_END) inBlock = false;
      continue;
    }
    if (line.endsWith(OURS) && TOP_KEYS.includes(topKey(line) ?? "")) continue;
    out.push(line.startsWith(SAVED) ? line.slice(SAVED.length) : line);
  }
  return out.join("\n").replace(/\n{3,}$/, "\n\n").replace(/^\n+/, "");
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

export function withRelayCodexConfig(text: string, o: RelayCodexOptions): CodexConfigResult {
  const base = withoutRelayCodexConfig(text);
  const lines = base.length ? base.split("\n") : [];
  const firstTable = firstTableLine(lines);
  // The user's own provider/model become comments (restored on logout); ours go first.
  const top = lines.slice(0, firstTable).map((l) => (TOP_KEYS.includes(topKey(l) ?? "") ? `${SAVED}${l}` : l));
  const rest = lines.slice(firstTable);
  const ours = [`model_provider = "${CODEX_PROVIDER_ID}"${OURS}`, `model = ${tomlString(o.model)}${OURS}`];
  const block = [
    BLOCK_START,
    `[model_providers.${CODEX_PROVIDER_ID}]`,
    `name = ${tomlString(`Keyless Relay (${o.agent})`)}`,
    `base_url = ${tomlString(`${o.relayUrl.replace(/\/+$/, "")}/api/relay/codex/v1`)}`,
    `wire_api = "responses"`,
    "",
    `[model_providers.${CODEX_PROVIDER_ID}.auth]`,
    `command = ${tomlString(o.authCommand)}`,
    `refresh_interval_ms = ${CODEX_TOKEN_REFRESH_MS}`,
    BLOCK_END,
  ].join("\n");
  const body = [...top, ...rest].join("\n").trimEnd();
  return { text: [...ours, ...(body ? [body, ""] : []), block, ""].join("\n") };
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
