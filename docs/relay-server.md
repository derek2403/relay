# Relay server and CLI

This app is also the relay (Keyless Relay, ported from `ethtokyo2026`). Provider keys stay on the server;
people and agents get ENS names on ENSv2 (Sepolia) whose text records say which APIs they may use and how much.
The product story and the demo script are in [demo.md](demo.md). This page covers running it in this repo.

`npm run dev` and `npm start` bind **http://127.0.0.1:3000**, so use that origin everywhere below
(`RELAY_PUBLIC_URL`, `--relay`, `RELAY_URL`).

## Configure

```bash
cp .env.example .env.local    # every setting is explained there; restart the server after changes
```

The settings a demo needs:

```bash
RELAY_ROOT_NAME=acme.eth                 # the company's .eth name (required for relaying)
RELAY_ROOT_OWNER=0x...                   # its owner; org:setup prints both lines
RELAY_PUBLIC_URL=http://127.0.0.1:3000   # base URL and token audience
OPENAI_API_KEY=sk-...                    # used by "codex" and "openai-images"
RELAY_ADMIN_TOKEN=...                    # openssl rand -hex 32; protects /policy, /log, /admin/reset
FUNDER_PRIVATE_KEY=0x...                 # small hot wallet with Sepolia ETH (optional)
FUNDER_AMOUNT_ETH=0.01
NEXT_PUBLIC_SEPOLIA_RPC_URL=...          # your own RPC; the public one is rate-limited
```

With `RELAY_ADMIN_TOKEN` set, sign in at `/api/relay/admin` to see spend and the log in the browser.

## API catalog

`lib/relay/catalog.ts` lists every API the relay can hold a key for. Adding one is one entry there plus its key.
An API without a key shows as "no key": it can still be delegated, but calls to it get 503.

| id | Key variable | Forwarded | Counted as | `$` cap |
|---|---|---|---|---|
| `claude` | `ANTHROPIC_API_KEY` | `POST /v1/messages`; `count_tokens` and model lists free | tokens (priced) | yes |
| `codex` | `OPENAI_API_KEY` | `POST /v1/responses`, `/v1/chat/completions`, `/v1/embeddings`; model lists free | tokens (estimated prices unless `RELAY_CODEX_PRICES`) | yes |
| `openai-images` | `OPENAI_API_KEY` | `POST /v1/images/generations`, `/v1/images/edits` | images (the request's `n`), $0.04 each | yes |
| `gemini` | `GEMINI_API_KEY` | `models/*:generateContent`, `:streamGenerateContent`, `:countTokens` (`v1beta`, `v1`) | 1 request, $0.01 estimate | yes |
| `github` | `GITHUB_TOKEN` | any path, except credential and access changes | 1 request | no |
| `railway` | `RAILWAY_TOKEN` | `POST /graphql/v2`, minus token/member mutations | 1 request | no |
| `vercel`, `linear`, `canva`, `hubspot`, `mailchimp`, `stripe`, `notion`, `slack` | `VERCEL_TOKEN`, `LINEAR_API_KEY`, `CANVA_TOKEN`, `HUBSPOT_TOKEN`, `MAILCHIMP_TOKEN`, `STRIPE_SECRET_KEY`, `NOTION_TOKEN`, `SLACK_BOT_TOKEN` | any method and path | 1 request | no |
| `mock` | none | any path; the relay answers itself | 1 request, $0.01 | yes |

`RELAY_UPSTREAM_<ID>` overrides an upstream (upper case, `-` as `_`, e.g. `RELAY_UPSTREAM_OPENAI_IMAGES`);
Mailchimp needs it for its data center. `RELAY_EXTRA_ROUTES` adds endpoints for the restricted APIs.

## Limits on ENS

A name's bundle is text records on the resolver of the level above it:

| Record | Meaning |
|---|---|
| `relay.keys` | Comma list of catalog ids the name may use. No record means no access. |
| `relay.period` | `month`, `day` (UTC) or `total`; when the limits reset |
| `relay.cap.<id>` | Dollar cap per period (only for APIs with `$` caps) |
| `relay.max.<id>` | Count cap per period: requests, or images for `openai-images` |
| `relay.nbf` | Tokens issued before this unix time are refused |
| `relay.plan` | Marks a shared plan record (`plan-<slug>.<parent>`) |

On every call the relay checks, for every level from the company down, that it is registered, genuine and
canonical, lists the API, and has dollars and count left. It reserves the worst case on every level first,
so parallel calls can't overrun a cap. Image and per-request calls count only on a 2xx answer.

**Live check.** While a call runs (for example a long stream), the relay re-reads the caller's chain every
`RELAY_LIVE_CHECK_SEC` seconds (default 5; `0` turns it off). If a level was removed or expired, or the
signer no longer owns the name, the call is cut off within one interval: an SSE stream ends with the
provider's own error event, other bodies are aborted, and the log records `killed: access revoked`. New
calls get `403 {"error":"access revoked","reason":"access revoked: <name> was removed or expired. Run relay login."}`.

## Endpoints

| Method and path | Auth | What it does |
|---|---|---|
| `ANY /api/relay/<id>/<path>` | agent token `kr1.…` in `x-api-key` or `Authorization: Bearer` (Gemini also `x-goog-api-key` or `?key=`) | Forwards with the real key |
| `GET /api/relay/status` | none | Setup: root, catalog providers (`configured`, `category`, `dollarCaps`, `countUnit`, `keyEnv`, `note`), `liveCheckSec`, `funder`; never key values |
| `GET /api/relay/policy?name=&provider=` | admin, or an agent token for that name or above it; open only in development without `RELAY_ADMIN_TOKEN` | Decision now, with `remaining`, `remainingCount` and every level's `spent`, `reserved` and `used` |
| `GET /api/relay/log?limit=` | same as `/policy` | Recent decisions, newest first |
| `GET/POST /api/relay/admin` | form with `RELAY_ADMIN_TOKEN` | Sign-in page; sets the admin cookie |
| `POST /api/relay/admin/reset` | admin; the no-body mode is open in development | Clears spend, counts and log entries of names no longer registered; `{"names":[…]}` clears exactly those |
| `GET /api/ens/children?name=` | none | Names registered directly under a name (503 while a first scan runs) |
| `GET /api/ens/owned?address=` | none, rate limited | Names under the root an address holds, deepest first (the CLI uses it to find "your" name) |
| `POST /api/fund {"name"}` | none; the chain is the check | Tops up a member's wallet from the funder |
| `GET /install.sh` | none | The CLI installer (`curl -fsSL <relay>/install \| sh`), with this relay as its default |
| `GET /cli/relay.mjs`, `/cli/relay.mjs.sha256` | none | The bundled CLI and its checksum (static files from `npm run build:cli`) |

**Funder.** `POST /api/fund` pays `FUNDER_AMOUNT_ETH` only to a member: a registered name under the root whose
levels above are all held by the company owner, held by someone other than the owner and the funder, whose
wallet is below `FUNDER_MIN_BALANCE_ETH`, once per registration, within `FUNDER_DAILY_LIMIT_ETH` per UTC
day. Grants are recorded in `.data/relay.json`. The admin UI calls it after adding a member; `relay login`
calls it when the wallet can't pay for gas.

Run one relay process per data directory: spend lives in that process and in `.data/relay.json`.

## `relay`: the user's CLI

`relay` runs on the user's laptop. The user holds one wallet key and the ENS name the admin gave it; only that
key sends transactions, agent keys only sign tokens.

**Install** (macOS or Linux, Node.js 20+, curl), from the relay itself:

```bash
curl -fsSL http://127.0.0.1:3000/install | sh
```

`GET /install.sh` (`app/install.sh/route.ts`, script in `lib/relay/install-script.ts`) returns a POSIX `sh`
script with this relay's address as its default: `RELAY_PUBLIC_URL`'s origin, else the address the request was
made to (`Host`, or `X-Forwarded-Host` / `X-Forwarded-Proto` behind a proxy; only a plain host name is used,
anything else leaves `RELAY_URL` to the user). A loopback `RELAY_PUBLIC_URL`
(`http://127.0.0.1:3000`, as in `.env.example`) is used only for requests to a loopback address; another machine
gets the address it asked for. The script:

- needs `node` 20 or newer and `curl`, and says so with a link to https://nodejs.org otherwise;
- downloads `/cli/relay.mjs` and `/cli/relay.mjs.sha256` (from an `https` relay, redirects must stay on `https`;
  a plain `http` relay that isn't this machine gets a warning, since nothing protects the download on the way),
  checks the checksum, runs `relay.mjs version`, then
  moves it into `~/.local/share/relay/relay.mjs` (mode 755, atomically) and links `~/.local/bin/relay` to it.
  An earlier link of its own is replaced; a `relay` that belongs to another program is left alone and the
  install stops. A missing build (404) stops it with "this relay has no CLI build" (under `next start`, restart
  the relay after the first `npm run build:cli`: it lists `public/` once at startup);
- writes `install.json` (`{ "relayUrl" }`) next to `relay.mjs` and saves the relay in `~/.relay/config.json`
  unless that already names a valid one (`relay config --relay <url> --if-unset`; a kept relay is shown with
  the exact `relay config --relay …` line to switch); it never touches your keys;
- warns when the Codex CLI is missing, and prints the `export PATH=…` line for `~/.zshrc` (`$ZDOTDIR` when set)
  / `~/.bashrc` and the `fish_add_path` line when `~/.local/bin` isn't on PATH;
- ends with the uninstall line for the folders it used (shell-quoted, removing only its own files) and
  `Next: relay init`.

`RELAY_URL`, `RELAY_INSTALL_DIR` (default `~/.local/share/relay`), `RELAY_BIN_DIR` (default `~/.local/bin`) and
`RELAY_HOME` change the defaults; set them for `sh` (`curl … | RELAY_URL=https://relay.example sh`). The two
folders must be absolute paths. The install stays outside `RELAY_HOME` (also through symlinks), so `demo:reset` and `relay logout --all` don't remove it. Re-run the installer to
update; uninstall with `rm ~/.local/bin/relay && rm -r ~/.local/share/relay` (`rm -r ~/.relay` deletes the keys).

**The bundle.** `npm run build:cli` (`scripts/build-cli.mjs`, esbuild, about 0.2 s) bundles `scripts/relay.ts`
with viem into `public/cli/relay.mjs` (about 850 KB, not minified, not committed) and writes its sha256 next to
it. `npm run dev` and `npm run build` run it first (`predev`, `prebuild`). The bundle embeds its version
(`package.json` + short git sha, with `-dirty` when the tree has uncommitted changes, e.g. `0.1.0+9dd0bd8-dirty`)
and the Codex templates from `scripts/templates/`. Rebuild after changing the CLI (`predev` only runs when
`npm run dev` starts).

**From this repo**, `./relay` (a wrapper for `scripts/relay.ts`; `npm run relay -- …` works too) runs the same CLI
from source. The two modes differ only here:

| | `relay` (installed) | `./relay` (repo) |
|---|---|---|
| Codex works in | the current folder, or `RELAY_WORKSPACE` (never your home folder, a folder above it, `/`, or anything overlapping `~/.relay`, also through symlinks) | `demo-workspace/` |
| Codex trusts | that folder, unless it has its own `.codex/` (project config, hooks, exec policies): then Codex asks | `demo-workspace/` and the repo |
| Settings files | `~/.relay/config.json`, then the installer's `install.json` | `~/.relay/config.json`, then the repo's `.env.local` |
| Templates | embedded at build time | read from `scripts/templates/` |

```bash
relay init [--relay URL]                    # make your key, print your address (send it to your admin)
relay whoami [--json]                       # address, names, balance, agent and subagents with spend
relay login [--name N] [--codex USD] [--images N] [--hours H] [--force]
relay codex [-- <codex args>]               # log in if needed, then start Codex through the relay
relay subagent create <label> [--codex USD] [--images N] [--minutes M]
relay subagent list [--json]
relay subagent remove <label>
relay exec --as <label> "<task>"            # codex exec as a subagent
relay image --as <label> --prompt "…" [--out file.png] [--size 1024x1024]
relay token [--as <label>]                  # print a relay token
relay env [--as <label>]                    # KEYLESS_TOKEN, OPENAI_BASE_URL, OPENAI_API_KEY exports
relay logout [--all]
relay config [--relay URL] [--rpc URL]      # show the relay and RPC in use (and where from); flags save them
relay version                               # also --version
```

- `login` finds your name with `/api/ens/owned` (or `--name`), asks `/api/fund` for gas if needed, deploys
  your resolver and registry, attaches it under your name, and creates `codex.<your name>` owned by a fresh
  agent key (defaults: Codex $5, 2 images, 8 h, period `total`; only APIs your own name allows).
- `codex` writes `AGENTS.md` and the `ens-subagents` skill (`.agents/skills/ens-subagents/SKILL.md`) into its
  workspace, with the right command (`relay` or `./relay`) in them; a file there it didn't write, or one
  reached through a symlink, is left alone. It then runs the Codex CLI (`npm i -g @openai/codex`) there with the relay as its model provider.
  Codex runs `relay` to create subagents (`research.codex.…`, `image.codex.…`); the installed CLI makes sure
  Codex's PATH finds it (if needed through a link in `~/.relay/bin/`).
- Files live in `~/.relay/` (`RELAY_HOME`): `user.json`, `config.json`, `session.json`, `agents/<name>.json`,
  `codex/`, and `bin/` when needed. Folder 700, files 600. Codex may write only `agents/` and `codex/`.
- Settings: `--relay` / `RELAY_URL` / `config.json` / the installer's `install.json` (installed) or
  `RELAY_PUBLIC_URL` from `.env.local` (repo), default `http://localhost:3000`; `--rpc` / `RELAY_RPC_URL` /
  `NEXT_PUBLIC_SEPOLIA_RPC_URL` / `config.json` / `.env.local` (repo), default Tenderly's public Sepolia gateway
  (`https://sepolia.gateway.tenderly.co`). `RELAY_CODEX_MODEL` and `RELAY_IMAGE_MODEL` (default `gpt-image-1`)
  pick models.

The older `npm run agent -- new|env|call|policy|token|primary-name` (`scripts/agent.ts`) still works for an
agent that keeps its own key in `.keyless/agent.json`.

## Demo scripts

| Command | What it does | Needs |
|---|---|---|
| `npm run org:setup` | Registers `<org>.eth` if needed and builds 3 departments, 6 teams, the launch squad (`launch.dev.eng.<org>.eth`), its non-canonical alias `launch.growth.marketing.<org>.eth` and member `mia`. Every level gets its own registry; every bundle lives on the admin's one resolver. Safe to re-run. Prints `RELAY_ROOT_NAME` and `RELAY_ROOT_OWNER`. | `ADMIN_PRIVATE_KEY`, `ORG_LABEL` (or `RELAY_ROOT_NAME`), Sepolia ETH |
| `npm run demo:reset` | Unregisters every name added under the teams (keeps launch, its alias and mia), calls `POST /api/relay/admin/reset`, and deletes `~/.relay/` (asks; `-- --yes` or `-- --keep-home`) | `ADMIN_PRIVATE_KEY`, `ORG_LABEL` or `RELAY_ROOT_NAME`, `RELAY_ADMIN_TOKEN`, `RELAY_URL` or `RELAY_PUBLIC_URL` |


## Checks

```bash
npm test            # lib/**/*.test.ts and tests/**/*.test.ts
npm run typecheck
npm run build:cli   # then: node public/cli/relay.mjs version
```
