# Relay

An admin portal and API relay for a company whose people and agents are ENS names on **ENSv2 (Sepolia)**.
Provider keys stay on the relay; each name carries its limits as text records, and every relayed call is
checked against the whole chain of names above it. Everything the portal shows comes from Sepolia or from
this relay: there is no demo mode and no in-browser sample data.

The relay and the ENS code are ported from `ethtokyo2026` (Keyless Relay). The demo script is
[docs/demo.md](docs/demo.md).

## Run

Requirements: Node 20+, a browser wallet (MetaMask, Rabby, Brave, …) on Sepolia with a little Sepolia ETH,
and optionally the Codex CLI (`npm i -g @openai/codex`) for the agent part of the demo.

```sh
npm install
cp .env.example .env.local        # every setting is explained there
npm run dev                       # http://127.0.0.1:3000 (portal and relay)
```

The settings that matter first (all in `.env.example`):

| Setting | What for |
|---|---|
| `RELAY_ROOT_NAME` | The company's `.eth` name, e.g. `acme.eth`. Without it the portal lets you type a name to set up, but the relay refuses calls. |
| `RELAY_ROOT_OWNER` | The wallet that owns it (`npm run org:setup` prints both lines). |
| `RELAY_PUBLIC_URL` | `http://127.0.0.1:3000` locally: the base URL agents use and the audience of their tokens. |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, … | Provider keys. The root owner can also set them from the Providers view (needs `RELAY_SECRET`). |
| `RELAY_SECRET` | `openssl rand -hex 32`. Encrypts keys saved in the portal and signs the owner's session. |
| `RELAY_ADMIN_TOKEN` | Protects spend, the decision log and resets; sign in at `/api/relay/admin`. |
| `FUNDER_PRIVATE_KEY` | Optional hot wallet that sends new members gas. |
| `NEXT_PUBLIC_SEPOLIA_RPC_URL` | Your own Sepolia RPC; the public default is rate limited. |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Optional. Adds WalletConnect/mobile wallets to the connect dialog; without it only browser wallets are offered. |
| `DSTACK_SIMULATOR_ENDPOINT` | Optional. Phala's dstack simulator for "View attestation" on a normal server. |

Then, in the portal:

1. **Connect a wallet** (sidebar pill, RainbowKit) and switch it to Sepolia.
2. **Setup** (05): relay status, the company checklist (register the `.eth` name, deploy a resolver, write
   company limits, enable names below), the Session Minter, the DNS alias and the gas funder. Or build the whole
   org from the terminal: `ADMIN_PRIVATE_KEY=0x… ORG_LABEL=acme npm run org:setup`.
3. **Access tree** (01): the company's names read from Sepolia. Select a name to add members, edit limits, change
   caps, use plans, extend, remove, start agent sessions and create subagents; the heading's **Add a member**
   opens the same flow for the selected name.
4. **Providers** (02): every API in the relay catalog with its key status. The root owner signs in with the
   wallet ("Sign in as owner") to edit keys; **View attestation** shows the relay's TDX quote when a dstack
   endpoint is available. The `mock` API is the relay's own test endpoint ($0.01 per call, no key).
5. **Agents** (03) and **Policies** (04): agent keys held in this browser, "Try a call", live spend and the
   relay log; shared plans and delegated caps.

`npm run build` then `npm start` serves the production build on the same address.

## Checks

```sh
npm run typecheck
npm test            # relay, ENS helpers and the portal's view logic
npm run build       # next build --webpack
```

## Structure

- `app/api/**`: the relay (`/api/relay/<provider>/…`, status, policy, log, admin, credentials, attestation),
  ENS listings (`/api/ens/children`, `/api/ens/owned`) and the gas funder (`/api/fund`).
- `lib/relay/**`, `lib/ens/**`, `lib/hooks/**`: the relay server, ENSv2 contracts and recipes, and the React
  hooks the portal uses, from `ethtokyo2026`. `lib/relay/credentials*`, `owner-session.ts` and `attestation*`
  are this repo's additions (see [docs/credentials-and-attestation.md](docs/credentials-and-attestation.md)).
- `components/live/**`: the portal. `LiveWorkspace.tsx` loads the tree and relay state and provides
  `LiveContext`; each folder (members, sessions, setup, policies, agents, providers, tx) owns one feature.
- `components/{shell,tree,details,activity,ui}`: presentational components fed by `lib/view-model.ts`, which
  `lib/live/view.ts` builds from ENS and relay data.
- `styles/*.css`: the khaki design, imported in cascade order by `app/layout.tsx`.
- `scripts/`: the `./relay` CLI, `org:seed`, `org:setup`, `demo:reset`, `agent`.
- `contracts/`: the SessionMinter (Foundry; `forge install foundry-rs/forge-std --no-git` first).

More: [docs/relay-server.md](docs/relay-server.md) (relay, catalog, limits, endpoints, CLI),
[docs/credentials-and-attestation.md](docs/credentials-and-attestation.md), [docs/demo.md](docs/demo.md).
