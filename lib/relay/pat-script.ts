// The PAT helper the relay serves at /pat (app/pat/route.ts):
//
//   curl -fsSL "<relay>/pat?name=derek.cloudops.dev.sodalabs.eth" | sh >> .env
//
// A PAT is a Keyless Relay token (kr1...) for one ENS name, signed on the user's own machine by the
// relay CLI with the key in RELAY_HOME (~/.relay) that owns the name. The relay never holds or
// makes it: this script only finds the installed CLI (lib/relay/install-script.ts puts it on PATH)
// and runs `relay pat --name <name> [--hours N]`, which prints .env lines on stdout
// (RELAY_BASE_URL, RELAY_API_KEY, OPENAI_BASE_URL, OPENAI_API_KEY) and its messages on stderr.
//
// Everything interpolated is validated first (a strict ENS name, an hour count, a plain origin)
// and single-quoted; a bad request gets a 400 whose body is a script that only prints the error.

import { tryNormalize } from "../ens/names";
import { installOrigin, requestOrigin, safeOrigin, shQuote } from "./install-script";

/** Longest PAT the script asks for, in hours (the CLI also caps it at the name's expiry and the relay's token lifetime). */
export const PAT_MAX_HOURS = 168;

/**
 * Lowercase letters, digits and hyphens in dot-separated labels, at least two labels (name.eth),
 * not starting with "-" (so it never reads as a command-line option).
 */
const PAT_NAME = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+$/;
const PAT_HOURS = /^[1-9][0-9]{0,2}$/;

/** `raw` when it is a normalized ENS name of plain labels, at most 255 characters; else null. */
export function patName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length > 255 || !PAT_NAME.test(raw)) return null;
  return tryNormalize(raw) === raw ? raw : null;
}

/** The whole number of hours 1..PAT_MAX_HOURS written in `raw` ("24", not "024" or "2e1"); else null. */
export function patHours(raw: string | null | undefined): number | null {
  if (typeof raw !== "string" || !PAT_HOURS.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= PAT_MAX_HOURS ? n : null;
}

export type PatQuery = { ok: true; name: string; hours: number | null } | { ok: false; error: string };

/** Reads ?name=<ens name>[&hours=N]. Missing, repeated or invalid values are errors. */
export function parsePatQuery(params: URLSearchParams): PatQuery {
  const names = params.getAll("name");
  if (names.length === 0 || names[0] === "") {
    return { ok: false, error: "name is required, e.g. /pat?name=derek.cloudops.dev.sodalabs.eth" };
  }
  if (names.length > 1) return { ok: false, error: "give name once" };
  const name = patName(names[0]);
  if (!name) {
    return { ok: false, error: "name must be an ENS name in lowercase letters, digits and hyphens with dots between labels, e.g. derek.cloudops.dev.sodalabs.eth" };
  }
  const hoursList = params.getAll("hours");
  if (hoursList.length > 1) return { ok: false, error: "give hours once" };
  if (hoursList.length === 0) return { ok: true, name, hours: null };
  const hours = patHours(hoursList[0]);
  if (hours === null) return { ok: false, error: `hours must be a whole number from 1 to ${PAT_MAX_HOURS}` };
  return { ok: true, name, hours };
}

/** The relay origin a script served for `request` names: RELAY_PUBLIC_URL's, else the request's (as /install does). */
export function scriptOrigin(request: Request, publicUrl = process.env.RELAY_PUBLIC_URL): string | null {
  const requestUrl = requestOrigin({
    url: request.url,
    host: request.headers.get("host"),
    forwardedHost: request.headers.get("x-forwarded-host"),
    forwardedProto: request.headers.get("x-forwarded-proto"),
  });
  return installOrigin({ publicUrl, requestUrl });
}

/** The body of a 400: a script that prints the error on stderr and exits 1 (so nothing lands in .env). */
export function patErrorScript(error: string): string {
  // Only fixed text from parsePatQuery reaches here, never the request's own values; quoted anyway.
  const line = error.replace(/[\r\n]+/g, " ");
  return `#!/bin/sh\n# Keyless Relay PAT: bad request. ${line}\nprintf '%s\\n' ${shQuote(`error: ${line}`)} >&2\nexit 1\n`;
}

/** The PAT script for `name` (and `hours`, when given), with `relayUrl` (null when unknown) as the relay. */
export function patScript(o: { relayUrl: string | null; name: string; hours?: number | null }): string {
  const name = patName(o.name);
  if (!name) throw new Error("patScript: invalid name");
  const hours = o.hours === undefined || o.hours === null ? null : patHours(String(o.hours));
  if (o.hours !== undefined && o.hours !== null && hours === null) throw new Error("patScript: invalid hours");
  const origin = safeOrigin(o.relayUrl);
  const shown = origin ?? "<relay URL>";
  const values: Record<string, string> = {
    "@@RELAY_URL@@": shQuote(origin ?? ""),
    "@@NAME@@": shQuote(name),
    "@@HOURS@@": shQuote(hours === null ? "" : String(hours)),
    "@@SHOWN_RELAY_URL@@": shown,
    "@@SHOWN_NAME@@": name,
    "@@SHOWN_HOURS@@": hours === null ? "" : ` --hours ${hours}`,
  };
  return SCRIPT.replace(/@@[A-Z_]+@@/g, (m) => values[m] ?? m);
}

// POSIX sh (dash, bash, zsh, busybox), like install.sh: everything runs inside main(), called on the
// last line, so a download cut short runs nothing; the CLI gets stdin from /dev/null (stdin is this
// script). No "${" in the text (a template literal). Only the CLI writes to stdout.
const SCRIPT = String.raw`#!/bin/sh
# Keyless Relay PAT for @@SHOWN_NAME@@
#
#   curl -fsSL "@@SHOWN_RELAY_URL@@/pat?name=@@SHOWN_NAME@@" | sh >> .env
#
# Runs your installed relay CLI: relay pat --name @@SHOWN_NAME@@@@SHOWN_HOURS@@
# It signs a token for the name on this machine, with the key in RELAY_HOME (~/.relay) that owns
# it, and prints RELAY_BASE_URL, RELAY_API_KEY, OPENAI_BASE_URL and OPENAI_API_KEY lines (messages
# go to stderr). No key comes from the relay, and the token stops working when the name is removed.
#
# Settings (environment variables, optional):
#   RELAY_URL   the relay the token is for (default: @@SHOWN_RELAY_URL@@)
#   RELAY_HOME  the CLI's keys (default: ~/.relay)
# The CLI itself: curl -fsSL @@SHOWN_RELAY_URL@@/install | sh

set -eu

relay_url=@@RELAY_URL@@
name=@@NAME@@
hours=@@HOURS@@

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# True for the Keyless Relay CLI (its first lines say so), never another program called relay.
is_relay_cli() {
  [ -f "$1" ] && head -n 5 "$1" 2>/dev/null | grep -q 'Keyless Relay CLI'
}

main() {
  relay_bin=''
  found=$(command -v relay 2>/dev/null || true)
  case $found in
    /*) ;;
    *) found='' ;;
  esac
  if [ -n "$found" ] && is_relay_cli "$found"; then relay_bin=$found; fi
  if [ -z "$relay_bin" ]; then
    home_dir=$(printenv HOME 2>/dev/null || true)
    if [ -n "$home_dir" ] && is_relay_cli "$home_dir/.local/bin/relay"; then relay_bin="$home_dir/.local/bin/relay"; fi
  fi
  if [ -z "$relay_bin" ]; then
    if [ -n "$found" ]; then printf '  ! %s\n' "$found is not the Keyless Relay CLI." >&2; fi
    install_from=$relay_url
    [ -n "$install_from" ] || install_from='<relay URL>'
    fail "the Keyless Relay CLI (relay) is not installed. Install it, then run relay init and ask your admin to add your address under your team's name:
  curl -fsSL $install_from/install | sh"
  fi

  # The token is for the relay this script came from, unless RELAY_URL says otherwise.
  if [ -z "$(printenv RELAY_URL 2>/dev/null || true)" ] && [ -n "$relay_url" ]; then
    RELAY_URL=$relay_url
    export RELAY_URL
  fi

  if [ -n "$hours" ]; then
    exec "$relay_bin" pat --name "$name" --hours "$hours" </dev/null
  fi
  exec "$relay_bin" pat --name "$name" </dev/null
}

main "$@"
`;
