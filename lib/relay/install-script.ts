// The CLI installer the relay serves at /install.sh (app/install.sh/route.ts):
//
//   curl -fsSL <relay>/install | sh
//
// It downloads the bundled CLI (npm run build:cli → public/cli/relay.mjs, served at /cli/relay.mjs),
// checks it against /cli/relay.mjs.sha256, installs it outside RELAY_HOME (demo:reset deletes
// ~/.relay) and links it as `relay` on PATH. The relay's own address is baked in as the default.

/** Host names (letters, digits, - and _ labels), IPv4 and bracketed IPv6: nothing a shell or a comment could trip on. */
const SAFE_HOST = /^(?:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.?|\[[0-9A-Fa-f:.]+\])$/;

/** The origin of an http(s) URL without credentials whose host is plain, else null. */
export function safeOrigin(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
  if (!SAFE_HOST.test(url.hostname)) return null;
  return url.origin;
}

/** localhost, *.localhost, 127.x.x.x, [::1] and 0.0.0.0: addresses that only reach the machine itself. */
const LOOPBACK_HOST = /^(?:localhost|[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)\.?$/i;
const isLoopback = (origin: string) => LOOPBACK_HOST.test(new URL(origin).hostname);

/**
 * The origin the client asked for: X-Forwarded-Host / X-Forwarded-Proto (first value) when a proxy
 * sets them, else Host, else the URL. Next builds request.url from its own --hostname and --port
 * (127.0.0.1:3000, or 0.0.0.0:3000 in the container), not from the Host header.
 */
export function requestOrigin(o: { url: string; host?: string | null; forwardedHost?: string | null; forwardedProto?: string | null }): string {
  const first = (v: string | null | undefined) => v?.split(",")[0].trim() || null;
  let url: URL;
  try {
    url = new URL(o.url);
  } catch {
    return o.url;
  }
  const proto = first(o.forwardedProto)?.toLowerCase();
  const protocol = proto === "http" || proto === "https" ? `${proto}:` : url.protocol;
  const host = first(o.forwardedHost) ?? first(o.host);
  return host ? `${protocol}//${host}` : url.origin;
}

/**
 * The relay address the installer defaults to: RELAY_PUBLIC_URL's origin when the relay has one,
 * else the origin the request came to (requestOrigin). A loopback RELAY_PUBLIC_URL (the .env.example default) is
 * only used for requests to a loopback address too: another machine would download from itself.
 * The request's Host is only a default string in the script (the user can override it with
 * RELAY_URL), and anything but a plain host name is refused.
 */
export function installOrigin(o: { publicUrl?: string | null; requestUrl: string }): string | null {
  const configured = safeOrigin(o.publicUrl);
  const requested = safeOrigin(o.requestUrl);
  if (configured && requested && isLoopback(configured) && !isLoopback(requested)) return requested;
  return configured ?? requested;
}

/** Single-quotes `s` for POSIX sh: nothing inside is expanded. */
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The installer script, with `relayUrl` (null when unknown: RELAY_URL is then required) as its default. */
export function installScript(o: { relayUrl: string | null }): string {
  const origin = safeOrigin(o.relayUrl);
  return SCRIPT.replace("@@DEFAULT_RELAY_URL@@", () => shQuote(origin ?? "")).replaceAll("@@SHOWN_RELAY_URL@@", () => origin ?? "<relay URL>");
}

// POSIX sh (dash, bash, zsh, busybox): no local, arrays or pipefail, and no zsh-reserved names (path,
// status). The text has no "${" (this is a template literal), so settings are read with printenv.
// Everything runs inside main(), called on the last line, so a download cut short runs nothing.
// Commands that could read stdin get /dev/null: stdin is this script.
const SCRIPT = String.raw`#!/bin/sh
# Keyless Relay CLI installer: puts the relay command on your PATH.
#
#   curl -fsSL @@SHOWN_RELAY_URL@@/install | sh
#
# Downloads <relay>/cli/relay.mjs (one Node.js file), checks it against <relay>/cli/relay.mjs.sha256,
# installs it in RELAY_INSTALL_DIR and links it as RELAY_BIN_DIR/relay. Your keys stay in RELAY_HOME
# (~/.relay); nothing is installed there. Run it again to update.
#
# Settings (environment variables for sh, all optional), e.g. curl -fsSL <relay>/install | RELAY_URL=https://relay.example sh
#   RELAY_URL          the relay to install from and use (default: @@SHOWN_RELAY_URL@@)
#   RELAY_INSTALL_DIR  where relay.mjs goes, an absolute path (default: ~/.local/share/relay)
#   RELAY_BIN_DIR      where the relay link goes, an absolute path (default: ~/.local/bin)
#   RELAY_HOME         the CLI's keys and settings (default: ~/.relay)
#
# Uninstall (the installer prints the exact line for your folders):
#   rm -f ~/.local/bin/relay ~/.local/share/relay/relay.mjs ~/.local/share/relay/install.json && rmdir ~/.local/share/relay
#   (rm -r ~/.relay also deletes your keys)

set -eu

default_relay_url=@@DEFAULT_RELAY_URL@@
tmp_dir=''
partial=''

say() { printf '%s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
cleanup() {
  if [ -n "$tmp_dir" ]; then rm -rf "$tmp_dir"; fi
  if [ -n "$partial" ]; then rm -f "$partial"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# The environment variable $1, or $2 when it is unset or empty.
setting() {
  value=$(printenv "$1" 2>/dev/null || true)
  if [ -n "$value" ]; then printf '%s' "$value"; else printf '%s' "$2"; fi
}

# $1 without trailing slashes.
no_slash() {
  printf '%s' "$1" | sed 's:/*$::'
}

# $1 quoted for sh when it needs it (in commands printed for pasting).
q() {
  case $1 in
    '' | *[!A-Za-z0-9_./:@%+=,-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    *) printf '%s' "$1" ;;
  esac
}

# $1 quoted for fish when it needs it.
fq() {
  case $1 in
    '' | *[!A-Za-z0-9_./:@%+=,-]*) printf "'%s'" "$(printf '%s' "$1" | sed 's/[\\'"'"']/\\&/g')" ;;
    *) printf '%s' "$1" ;;
  esac
}

# The sh line that puts the folder $1 first on PATH.
path_line() {
  case $1 in
    *[!A-Za-z0-9_./:@%+=,-]*) printf 'export PATH=%s:"$PATH"' "$(q "$1")" ;;
    *) printf 'export PATH="%s:$PATH"' "$1" ;;
  esac
}

# The absolute path $1 with symlinks resolved as far as it exists (the rest appended as is).
physical() {
  p=$1
  rest=''
  while [ ! -d "$p" ]; do
    rest="/$(basename "$p")$rest"
    p=$(dirname "$p")
  done
  real=$(cd -P "$p" 2>/dev/null && pwd -P) || real=$p
  if [ "$real" = / ] && [ -n "$rest" ]; then real=''; fi
  printf '%s%s' "$real" "$rest"
}

# Downloads $1 to $2 (from an https relay, redirects stay on https); a 404 means the relay has no CLI build.
fetch() {
  http_code=$(curl -sSL --proto "$protocols" --proto-redir "$protocols" --retry 2 -o "$2" -w '%{http_code}' "$1") ||
    fail "could not download $1. Is the relay running, and is RELAY_URL right?"
  case $http_code in
    200) ;;
    404) fail "$1 was not found (404): this relay has no CLI build. Its operator runs npm run build:cli (npm run dev and npm run build do it too), then restarts the relay if it runs with next start." ;;
    *) fail "$1 answered HTTP $http_code." ;;
  esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' -- "$1" </dev/null
  fi
}

# True for the Keyless Relay CLI (the bundle's first lines say so).
is_relay_cli() {
  head -n 5 "$1" 2>/dev/null | grep -q 'Keyless Relay CLI'
}

main() {
  home_dir=$(setting HOME '')
  [ -n "$home_dir" ] || fail "HOME is not set."
  relay_url=$(setting RELAY_URL "$default_relay_url")
  [ -n "$relay_url" ] || fail "set RELAY_URL to your relay's address, e.g. curl -fsSL https://relay.example/install | RELAY_URL=https://relay.example sh"
  install_dir=$(no_slash "$(setting RELAY_INSTALL_DIR "$home_dir/.local/share/relay")")
  bin_dir=$(no_slash "$(setting RELAY_BIN_DIR "$home_dir/.local/bin")")
  [ -n "$install_dir" ] && [ -n "$bin_dir" ] || fail "RELAY_INSTALL_DIR and RELAY_BIN_DIR can't be /."
  for dir in "$install_dir" "$bin_dir"; do
    case $dir in
      /*) ;;
      *) fail "RELAY_INSTALL_DIR and RELAY_BIN_DIR must be absolute paths (got: $dir). Write \$HOME/..., since a quoted ~ is not expanded." ;;
    esac
  done
  # demo:reset and relay logout --all delete RELAY_HOME, so nothing is installed there (compared as
  # written and with symlinks resolved; the CLI reads a relative RELAY_HOME from the current folder).
  relay_home=$(no_slash "$(setting RELAY_HOME "$home_dir/.relay")")
  case $relay_home in
    '' | /*) ;;
    *) relay_home="$(pwd -P)/$relay_home" ;;
  esac
  relay_home_real=$relay_home
  [ -z "$relay_home" ] || relay_home_real=$(physical "$relay_home")
  for dir in "$install_dir" "$bin_dir"; do
    inside=''
    case "$dir/" in "$relay_home"/*) inside=1 ;; esac
    case "$(physical "$dir")/" in "$relay_home_real"/*) inside=1 ;; esac
    [ -z "$inside" ] || fail "$dir is inside RELAY_HOME ($relay_home), which demo:reset and relay logout --all delete. Pick a folder outside it."
  done

  command -v curl >/dev/null 2>&1 || fail "curl is required."
  command -v node >/dev/null 2>&1 || fail "relay needs Node.js 20 or newer, and node was not found. Install it from https://nodejs.org, then run this again."
  node_version=$(node -p 'process.versions.node' </dev/null 2>/dev/null || true)
  node_major=$(node -p 'process.versions.node.split(".")[0]' </dev/null 2>/dev/null || true)
  case $node_major in
    '' | *[!0-9]*) fail "could not read the Node.js version (node -p process.versions.node). relay needs Node.js 20 or newer: https://nodejs.org" ;;
  esac
  [ "$node_major" -ge 20 ] || fail "relay needs Node.js 20 or newer, and this is Node.js $node_version. Update it from https://nodejs.org, then run this again."

  # The CLI's own normalization: http(s) only, no credentials, no trailing slash or /api/relay.
  normalized=$(node -e 'try { const u = new URL(process.argv[1]); if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw 0; process.stdout.write(u.origin + u.pathname.replace(/\/+$/, "").replace(/\/api\/relay$/, "")); } catch { process.exit(1); }' -- "$relay_url" </dev/null) ||
    fail "RELAY_URL must be the relay's http(s) address, e.g. https://relay.example (got: $relay_url)."
  relay_url=$normalized
  case $relay_url in
    https://*) protocols='=https' ;;
    *) protocols='=http,https' ;;
  esac

  say "Installing the Keyless Relay CLI from $relay_url"
  case $relay_url in
    http://*)
      node -e 'const h = new URL(process.argv[1]).hostname; process.exit(/^(localhost|.+\.localhost|127(\.\d{1,3}){3}|\[::1\])$/i.test(h) ? 0 : 1)' -- "$relay_url" </dev/null ||
        warn "$relay_url is plain http to another machine: nothing protects the download (or its checksum) on the way. Use the relay's https address if it has one."
      ;;
  esac
  tmp_dir=$(mktemp -d 2>/dev/null || mktemp -d -t relay-install)
  fetch "$relay_url/cli/relay.mjs" "$tmp_dir/relay.mjs"
  fetch "$relay_url/cli/relay.mjs.sha256" "$tmp_dir/relay.mjs.sha256"

  # Catches a cut-off or mixed-up download (both files come from the same relay).
  expected=$(tr -d ' \t\r\n' <"$tmp_dir/relay.mjs.sha256" | cut -c 1-64 | tr 'A-F' 'a-f')
  printf '%s\n' "$expected" | grep -Eq '^[0-9a-f]{64}$' || fail "$relay_url/cli/relay.mjs.sha256 is not a sha256 checksum."
  actual=$(sha256_of "$tmp_dir/relay.mjs" | tr 'A-F' 'a-f')
  [ "$actual" = "$expected" ] || fail "checksum mismatch: relay.mjs has sha256 $actual, but relay.mjs.sha256 says $expected. Try again; if it keeps failing, the relay's operator should run npm run build:cli."
  version=$(node "$tmp_dir/relay.mjs" version </dev/null 2>&1) || fail "the downloaded CLI does not run on Node.js $node_version: $version"

  target="$install_dir/relay.mjs"
  link="$bin_dir/relay"
  # Checked before anything is created, so a refusal leaves no empty folders behind.
  if [ -L "$link" ]; then
    # An earlier install's link (also to another install dir, or dangling) is replaced; another program's is not.
    if [ -e "$link" ] && ! is_relay_cli "$link"; then
      fail "$link links to another program. Move it away, or run again with RELAY_BIN_DIR set to another folder on your PATH."
    fi
  elif [ -e "$link" ]; then
    is_relay_cli "$link" || fail "$link already exists and is not the Keyless Relay CLI. Move it away, or run again with RELAY_BIN_DIR set to another folder on your PATH."
  fi

  mkdir -p "$install_dir" "$bin_dir"
  # Atomic: a relay command running right now sees the old file or the new one, never half of one.
  partial="$install_dir/.relay.mjs.$$"
  cp "$tmp_dir/relay.mjs" "$partial"
  chmod 755 "$partial"
  mv -f "$partial" "$target"
  partial=''
  if [ -L "$link" ] || [ -e "$link" ]; then rm -f "$link"; fi
  ln -s "$target" "$link"

  # The relay this came from, for the CLI to fall back on (also after demo:reset deletes RELAY_HOME).
  node -e 'const fs = require("fs"); const [file, relayUrl] = process.argv.slice(1); fs.writeFileSync(file + ".tmp", JSON.stringify({ relayUrl }, null, 2) + "\n"); fs.renameSync(file + ".tmp", file);' -- "$install_dir/install.json" "$relay_url" </dev/null
  # And RELAY_HOME/config.json, unless it already names a relay (the CLI writes it, 700/600 like its keys).
  node "$target" config --relay "$relay_url" --if-unset </dev/null >/dev/null || warn "could not save the relay address; run: relay config --relay $relay_url"

  say "  ✓ $version: $link -> $target"
  command -v codex >/dev/null 2>&1 || warn "the Codex CLI was not found; relay codex needs it: npm i -g @openai/codex"

  case ":$(setting PATH ''):" in
    *":$bin_dir:"*)
      found=$(command -v relay 2>/dev/null || true)
      if [ -n "$found" ] && [ "$found" != "$link" ]; then warn "another relay comes first on your PATH ($found); put $bin_dir before it."; fi
      ;;
    *)
      export_line=$(path_line "$bin_dir")
      zdotdir=$(setting ZDOTDIR '')
      if [ -n "$zdotdir" ]; then zshrc=$(q "$zdotdir/.zshrc"); else zshrc='~/.zshrc'; fi
      say ""
      say "$bin_dir is not on your PATH. Add it:"
      say "  zsh:   echo $(q "$export_line") >> $zshrc"
      say "  bash:  echo $(q "$export_line") >> ~/.bashrc   (~/.bash_profile on macOS)"
      say "  fish:  fish_add_path $(fq "$bin_dir")"
      say "Then open a new terminal, or run this in the current one:"
      say "  $export_line"
      ;;
  esac

  say ""
  say "Uninstall: rm -f $(q "$link") $(q "$target") $(q "$install_dir/install.json") && rmdir $(q "$install_dir")"
  say ""
  say "Next: relay init"
  say "  1. relay init     creates your key and prints your address"
  say "  2. send that address to your admin, who adds you under your team's ENS name"
  say "  3. relay login    then relay codex"
}

main "$@"
`;
