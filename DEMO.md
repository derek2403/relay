# Demo runbook

Stage demos on **https://relay.derek2403.win**, with the company `sodalabs.eth` on ENSv2 Sepolia.

1. **Codex with an ENS identity.** Derek gets a name instead of an API key. Codex runs as its own name, makes
   subagents, hits its budget, and stops within seconds when Derek is removed.
2. **One PAT for LLM + weather + images.** One `curl` puts a token for Derek's ENS name into an app's `.env`.
   A small OpenAI-style web app then uses the LLM, OpenWeatherMap and image generation with that one token.
3. **Proof you can check.** `npm run verify:live` reads the live org from Sepolia and shows why a member can't
   raise his own limits. **View attestation** fetches a fresh Intel TDX quote from Phala Cloud with your nonce.
4. **A blockchain agent with delegated MultiBaas access.** Derek's agent reviews the treasury, pays an approved
   supplier, deploys and pauses an escrow on Sepolia through MultiBaas, and is refused everything outside its grant.
5. **Human approval with World ID.** A payout subagent asks at renewal for more than it had. The relay pauses it,
   and only a human who passes World ID's Selfie Check can let it resume, with a narrower scope.

| Sponsor | What to show |
|---|---|
| ENS | Every demo: names are identities, limits and blockchain grants live on ENS, removal revokes at once |
| Phala | Demo 3, part B: a fresh TDX quote from Phala Cloud, checked in the browser and by Phala's verifier |
| MultiBaas | Demo 4: monitor, pay, deploy and manage on Sepolia through MultiBaas, all delegated down the tree (also Demo 3, part C) |
| World | Demo 5: a paused agent resumes only after a Selfie Check by the approver whose World ID is linked |

| Name | What it is |
|---|---|
| `cloudops.dev.sodalabs.eth` | The team you add Derek under (seeded) |
| `derek.cloudops.dev.sodalabs.eth` | You, added live. Owned by the key `relay init` makes |
| `codex.derek.cloudops.dev.sodalabs.eth` | Codex's agent, made by `relay login` ($0.30) |
| `research.codex.derek…`, `image.codex.derek…` | Subagents Codex makes ($0.10 each, 5 minutes) |

## One-time setup

1. **Deploy this version** (from the repo on the Mac): commit, then run `deploy/deploy.sh`. Check the result:
   ```sh
   curl -s https://relay.derek2403.win/api/relay/status | grep -o '"id":"weather"'
   curl -fsSL "https://relay.derek2403.win/pat?name=derek.cloudops.dev.sodalabs.eth" | head -2
   ```
   The first command prints `"id":"weather"`. The second prints the start of a shell script.
2. **Install or update the CLI and Codex** on the demo laptop:
   ```sh
   curl -fsSL https://relay.derek2403.win/install | sh
   relay help | grep pat          # the new "relay pat" command is there
   npm i -g @openai/codex
   ```
3. **Allow weather and images down the tree** (once, from the repo):
   ```sh
   npm run org:seed -- --plan                  # optional: the tree and its limits, sends nothing
   ADMIN_PRIVATE_KEY=0x… npm run org:seed
   ```
   It only sends what differs from Sepolia. For this change, that is the limits of `sodalabs.eth`,
   `dev.sodalabs.eth` and `cloudops.dev.sodalabs.eth`, one transaction each. Weather becomes allowed at 10000,
   5000 and 1000 requests a month, and OpenAI Images at 300 (dev) and 100 (cloudops) images a month. Without
   this step, cloudops can't offer Weather, and weather calls fail with `does not allow weather`.
4. **Admin sign-in:** open https://relay.derek2403.win/api/relay/admin, paste `RELAY_ADMIN_TOKEN`, and click
   **Sign in**. Without it, the Live view shows no spend and no log.
5. **Browser wallet:** import the admin key into MetaMask or Rabby and switch to Sepolia. In the portal, click
   **Connect wallet** in the sidebar. The admin wallet needs a little Sepolia ETH: adding a member takes 2
   transactions and removing one takes 1. The funder wallet (`FUNDER_PRIVATE_KEY`) needs some too, because it
   sends Derek gas for `relay login` and subagents.
6. **OpenAI credit and budget:** the account behind the server's `OPENAI_API_KEY` needs prepaid credit. As a
   backstop, set a monthly limit in the OpenAI dashboard. The relay's caps bound each run: Derek gets $2 of
   Codex, 3 images and 20 weather calls. The relay stops a run at about $2.20 of estimated spend, and a run
   usually uses much less. The relay's dollar figures are estimates: it prices `gpt-5.3-codex` and
   `gpt-5.4-mini` at GPT-5 rates, and images at $0.04 each. Weather (OpenWeatherMap) calls are counted, not
   priced: OpenWeatherMap's free plan covers the demo.
7. **OpenWeatherMap key:** the relay needs `OPENWEATHER_API_KEY` (from https://home.openweathermap.org/api_keys).
   Put it in the server's `.env`, or open the **Providers** page (signed in as the root owner or admin) and use
   **Edit credentials** on **Weather (OpenWeatherMap)**. The key lives only on the relay: the relay adds it to each
   call as `?appid=`, and apps and agents never see it. Check it:
   ```sh
   curl -s https://relay.derek2403.win/api/relay/status | grep -o '"id":"weather"[^}]*"configured":[a-z]*'
   ```
   It ends in `"configured":true`. A new key can take up to about 2 hours to activate at OpenWeatherMap.

## Before each demo

```sh
relay logout                     # only if a previous run is still logged in: puts your own Codex config back
RELAY_URL=https://relay.derek2403.win ADMIN_PRIVATE_KEY=0x… npm run demo:reset -- --yes
```

The reset removes Derek (and everything under him), clears his spend, and deletes `~/.relay`. It keeps the
seeded org. To clear spend, the `RELAY_ADMIN_TOKEN` in your `.env.local` must match the server's.

Before you start, open the portal on **Access tree**, with the wallet connected and admin sign-in done. Then
open a terminal.

## Demo 1: Codex with an ENS identity

1. **"I'm new here. I get an identity, not an API key."**
   ```sh
   relay init
   ```
   Copy the address it prints.
2. **"My admin adds me."** In the portal, go to **Access tree**, select `cloudops.dev.sodalabs.eth`, and click
   **Add a member**:
   - ENS label `derek`, and paste the address as **Owner wallet**
   - tick **OpenAI text (Codex)** `$2`, **OpenAI Images** `3` and **Weather (OpenWeatherMap)** `20`

   Click **Add derek.cloudops.dev.sodalabs.eth** and confirm the 2 wallet prompts. The funder then tops up
   Derek's gas automatically. The editor only offers what cloudops itself allows.
3. **"I log in with my ENS name."**
   ```sh
   relay login
   ```
   This takes about a minute. It creates `codex.derek.cloudops.dev.sodalabs.eth` with its own key and **$0.30**,
   and points plain `codex` at the relay.
4. **"Codex works, and spend moves."**
   ```sh
   mkdir -p ~/relay-demo && cd ~/relay-demo && codex
   ```
   > Build a one-page site in index.html about ENS names as identities for AI agents.

   Select `derek` in the portal. The Live view shows spend on `codex.derek…` and on every level above it.
5. **"Codex makes its own subagents."**
   > Use two subagents: a research subagent to find three facts about ENSv2, and an image subagent to make a
   > header image. Then add both to the page.

   Codex asks to run `relay subagent create research …` and `relay subagent create image …` outside the
   sandbox. Approve both. Each subagent gets its own key and ENS name, $0.10 and 5 minutes, and appears in
   the Live view.
6. **"The budget on ENS is enforced."** Keep prompting ("add a FAQ section, dark mode and tests") until Codex
   reports `codex.derek.cloudops.dev.sodalabs.eth has used its codex cap ($0.3)`. It may first say "not enough
   budget left for this call", which has the same cause.
7. **"I revoke it."** In the portal, select `derek`. Click **Remove derek.cloudops.dev.sodalabs.eth** in the
   Live view (or **Remove name & descendants** in Derek's panel), then **Yes, remove it**, and confirm in the
   wallet. A Codex answer still streaming is cut within about 5 seconds with **access revoked**. The agent
   and both subagents are refused from then on, and nobody rotated a key.

   Codex is only cut mid-stream if it is still answering when you remove Derek. Once the cap is reached it
   can't start a new answer. For the live cut, remove Derek during a long prompt before step 6. After step 6,
   the refusal on the next prompt changes from the cap message to `access revoked`.
8. **Afterwards:** `relay logout`, then run the reset from "Before each demo".

## Demo 2: One PAT for LLM + weather + images

Before you start, Derek must exist with **Codex**, **OpenAI Images** and **Weather** ticked, and this laptop
must hold the key that owns him. After a reset, repeat Demo 1 steps 1 and 2 (`relay init`, then **Add a
member**). You don't need `relay login`. To keep your key across resets, add `--keep-home` to the reset
command: then skip `relay init` and paste the address `relay whoami` shows.

1. **"One curl gives my app a key."** In the repo:
   ```sh
   cd examples/weather-image-app
   curl -fsSL "https://relay.derek2403.win/pat?name=derek.cloudops.dev.sodalabs.eth" | sh >> .env
   cut -c1-60 .env                  # show it without the whole token
   ```
   The relay serves a script that runs your local `relay pat`. It signs a token (a PAT, valid up to 24 h) for
   the ENS name with the key in `~/.relay`, so no key comes from the relay. The portal shows the same line:
   select `derek` and click **PAT for apps**.

   Optional check, which costs no model spend:
   ```sh
   set -a; . ./.env; set +a
   curl -s "$RELAY_BASE_URL/weather/data/2.5/weather?q=Tokyo&units=metric" -H "Authorization: Bearer $RELAY_API_KEY"
   ```
   It prints OpenWeatherMap's JSON for Tokyo (`"main":{"temp":…}`). `does not allow weather` means setup step 3
   hasn't run; `no weather key (OPENWEATHER_API_KEY)` means setup step 7 hasn't.
2. **Start the app:**
   ```sh
   node server.mjs
   ```
   It prints `http://localhost:5173  ·  PAT for derek.cloudops.dev.sodalabs.eth via https://relay.derek2403.win/v1`.
3. Open **http://localhost:5173** and click **Ask**. The prompt is already filled in: *Get the weather of Tokyo
   today and generate an image based on it*. The page adds a row for each call as it happens:
   **LLM**, **get_weather** (for example `Tokyo: 17.8 °C (feels 19.9 °C), broken clouds, humidity 70 %, wind 3.1 m/s`), **LLM**,
   **generate_image**, then the image and the answer.
4. **"Three APIs, one PAT, no provider key in the app."** In the portal, select `derek`. The Live view lists
   the calls, all made as `derek.cloudops.dev.sodalabs.eth`: `codex` (chat completions), `weather`
   (OpenWeatherMap) and `openai-images`. Spend and counts rise on Derek, cloudops, dev and sodalabs.eth. The
   app's `.env` holds only the PAT: the OpenAI and OpenWeatherMap keys stay on the relay.
5. **Optional, the image cap:** click **Ask** again until the **generate_image** row turns red:
   `403 denied: derek.cloudops.dev.sodalabs.eth has used its openai-images limit (3 images)`. The model's answer
   explains why. If you kept Derek from Demo 1, the images Codex made there count toward the 3.
6. **Revoke:** in the portal, select `derek`, click **Remove derek.cloudops.dev.sodalabs.eth**, then **Yes,
   remove it**. Click **Ask**: the first call is refused with `403 access revoked`.
7. **Afterwards:** `rm .env`, then run the reset.

**Combined finale:** run Demo 2 steps 1 to 4 right after Demo 1 step 6. Codex's agent is out of budget, but
Derek himself still has budget, so the web app keeps working. One **Remove** then stops Codex, its subagents
and the web app together.

## Demo 3: Proof you can check

No wallet or Codex needed. Open a terminal in the repo and the portal on **Providers**.

### A. The org on ENS, read live (ENS)

```sh
npm run verify:live
```

It takes about 15 seconds, sends nothing and signs nothing. Walk through its four sections:

1. **Live org:** every name under `sodalabs.eth`, each with its owner, its limits and an Etherscan link. Every
   value is read from Sepolia now.
2. **A member can't raise his own limits:** `hasRoles` shows the member holds no roles on the resolver that stores
   his limits. The level above him wrote them, and only it can change them.
3. **A forbidden write reverts:** the member's own address tries to raise his cap, give himself the text role,
   move his resolver and delete a colleague. Each one reverts with the contract's own error, for example
   `EACUnauthorizedAccountRoles … ROLE_SET_TEXT`.
4. **An alias is refused:** `cloudops.biz.sodalabs.eth` points at the same registry as
   `cloudops.dev.sodalabs.eth`. The relay allows `emma.cloudops.dev…` and refuses `emma.cloudops.biz…` as
   `not-canonical`, so a second path to the same people can't dodge the limits on the first.

### B. A fresh TEE quote (Phala)

In the portal, open **Providers** and click **View attestation** on **TEE attestation**. The page makes a new
random nonce, and the relay fetches a quote for it from the attestation service on Phala Cloud. Four checks:

- **Intel TDX quote:** the page reads the quote's bytes itself (version 4).
- **Made for this request:** the nonce is inside the quote, so it can't be an old one.
- **The quote pins the service's compose file:** the compose hash is inside the quote (MRCONFIGID), and the
  compose file pins the exact image, `derek2403/attestation-server@sha256:2413…`.
- **Intel signature and certificate chain verified:** Phala's public verifier checked it. **Open the report** or
  **Verify on Phala** shows the same result on proof.t16z.com.

Click **Fresh quote**: a new nonce, a new quote, the checks again. Anyone can do the same from a terminal:

```sh
URL=https://917014871a337b76a5b3554e26b2d42a00499a45-8080.dstack-pha-prod9.phala.network
curl -s "$URL/attestation?nonce=$(openssl rand -hex 32)"   # your nonce is the quote's report data
curl -s "$URL/info"                                         # app id, compose hash, measurements
```

Say it plainly if asked: the quote covers the attestation service running in the TDX VM. The relay API itself
runs on its own server.

### C. MultiBaas is connected, and no agent can reach it directly (MultiBaas)

1. On **Providers**, scroll to **Blockchain**. **MultiBaas (Curvegrid)** shows **Connected · URL and key set**,
   with `MULTIBAAS_API_KEY` and `MULTIBAAS_URL` together. **Edit credentials** changes both in one dialog (sign
   in with the root owner's wallet first). The key never leaves the relay.
2. Show that connecting it authorizes nobody. With the PAT from Demo 2 (`set -a; . ./.env; set +a` in
   `examples/weather-image-app`):
   ```sh
   curl -s "$RELAY_BASE_URL/multibaas/api/v0/chains/ethereum/status" -H "Authorization: Bearer $RELAY_API_KEY"
   ```
   It answers `403 the relay never forwards requests to MultiBaas (Curvegrid) directly`, or, if Derek has no
   blockchain grant, `… does not allow multibaas`. Agents reach MultiBaas only through the blockchain actions
   delegated to them (Demo 4).

## Demo 4: A blockchain agent with delegated MultiBaas access

The company connects one MultiBaas deployment (Ethereum Sepolia) to the relay. Blockchain permissions travel
down the same ENS tree as API limits, in a `relay.chain` record next to them: capabilities (read, track, prepare,
submit, deploy, manage), contracts, methods, approved recipients, a per-payment maximum, a monthly limit, gas and
the approval rule. Each level can only narrow the level above, and a payment counts against every level.

| On Sepolia | Address |
|---|---|
| Treasury vault (holds the STD, pays only approved recipients within its own limits) | [0xD78b…c576](https://sepolia.etherscan.io/address/0xD78b2C8CC860BdC1d8A95Be791ccb89B5eFBc576) |
| Soda Test Dollar (STD) | [0x219b…48F9](https://sepolia.etherscan.io/address/0x219bfF215855BDACb72aD747d6d343B1271b48F9) |
| Relay signer (signs approved transactions; can only pay through the vault) | [0x8076…6FA0](https://sepolia.etherscan.io/address/0x8076AE8b234d54f5Eb8e73E2E6b514835a376FA0) |
| Supplier / contractor (the approved recipients) | `0xDf09…8B9c` / `0x2c23…57d0` |
| Escrow template `relay-escrow 1.0` | bytecode hash `0xaa3756d7…0b`, deployed per task |

### Setup (once; already done)

1. `npm run chain:setup` deployed the token and vault through MultiBaas, uploaded the escrow template, seeded the
   treasury history (including a 250 STD payment to an unapproved address) and wrote `org/chain.json`.
2. `ADMIN_PRIVATE_KEY=0x… npm run org:seed` wrote the blockchain grants of `sodalabs.eth`, `dev` and `cloudops`.
3. The server's `.env` holds `MULTIBAAS_URL`, `MULTIBAAS_API_KEY` and `MULTIBAAS_SIGNER_PRIVATE_KEY`. Check:
   ```sh
   curl -s https://relay.derek2403.win/api/relay/chain/status
   ```
   It shows `"configured":true`, the vault's balance and the signer's ETH.

**Within 3 days of the demo:** MultiBaas's free plan keeps indexed events for 72 hours, so the monitoring step
only sees recent history. Re-emit it (small transfers plus the flagged 250 STD one) the day before:
```sh
ADMIN_PRIVATE_KEY=0x… npm run chain:setup -- --reseed
```

### Before the demo

1. Derek exists (Demo 1 steps 1 and 2). In **Add a member**, the **Blockchain (MultiBaas)** section is on by
   default with what `cloudops` allows; leave it on.
2. Derek's agent gets a narrower grant:
   ```sh
   relay login --chain-max 5 --chain-limit 20
   ```
   The output ends with `chain read, track, prepare, submit, deploy, manage · to 0xdf09…, 0x2c23… · 5 STD per tx,
   20 STD per month · approval always`.
3. In the portal, connect the admin wallet and open **Approvals** in a second tab.

### The demo

The agent's tasks run from the terminal (the agent's key is in `~/.relay`). Each prints the plan, what the relay
did with every step, and a report. Approvals happen in the portal.

1. **Monitor.**
   ```sh
   relay chain task "Review our treasury's recent transfers and flag unusually large outgoing payments."
   ```
   It lists the vault's outgoing transfers with the block range and flags the 250 STD payment twice: `[large]`
   (over the 50 STD threshold) and `[unapproved-recipient]`, each with its Etherscan link. The report ends with
   "A flag is a rule match, not proof of wrongdoing."
2. **Prepare.**
   ```sh
   relay chain task "Prepare a payment of 3 test tokens to our approved supplier."
   ```
   → `prp_…  awaiting-approval  pay 3 STD to supplier (0xDf09…) from the vault`.
3. **Approve.** In **Approvals**, open the proposal: network, relay signer, vault, `pay(supplier, 3 STD)`, gas, the
   grant id. Click **Approve** and sign in the wallet. The message names the proposal, the amount, the recipient and
   the proposal's digest: changing anything needs a new approval.
4. **Execute and track.**
   ```sh
   relay chain task "Submit the approved payment and track it until confirmation."
   relay chain status prp_…
   ```
   The relay checks everything again, reserves 3 STD at every level, signs with the relay signer and submits through
   MultiBaas. The proposal goes **submitted → included → confirmed** (about 30 seconds) with the transaction link.
   In **Approvals**, the proposal shows the allowance used at `sodalabs.eth`, `dev`, `cloudops`, `derek` and his agent.
5. **Deploy.**
   ```sh
   relay chain task "Deploy our approved escrow template: 5 test tokens to the supplier, paid from the vault, with me (the agent's owner) as admin."
   ```
   The proposal names Derek's wallet as admin: the relay refuses its own signer or anyone outside the levels above.
   Approve it in the portal, then `relay chain task "Submit the approved deployment."`. `relay chain status prp_…`
   shows the escrow's address once confirmed; MultiBaas now indexes its events.
6. **Manage.**
   ```sh
   relay chain task "Check whether the escrow is paused, and if it isn't, propose pausing it."
   ```
   The relay runs the read first (`paused` → `false`), then the model proposes `pause()`. Approve, then
   `relay chain task "Submit the approved proposal."`, then
   `relay chain task "Show the escrow's recent events."`: the `Paused` event is there.
7. **Reject.** Each is refused before anything is signed, with the rule named (and listed in **Approvals** as
   blocked):
   ```sh
   relay chain task "Pay 3 test tokens to 0x000000000000000000000000000000000000dEaD"   # [recipient]
   relay chain task "Pay 500 test tokens to the supplier"                             # [amount] over 5 STD
   relay chain task "Prepare a call to transferAdmin on the escrow, making 0x000000000000000000000000000000000000dEaD the admin."   # [method]
   ```
8. **Narrower subagent.**
   ```sh
   relay subagent create watch --chain read,track --minutes 30
   relay chain task "Prepare a payment of 3 test tokens to our approved supplier." --as watch   # [cap:prepare]
   relay chain task "Review our treasury's recent transfers." --as watch                     # works
   ```
9. **Revoke.** Remove Derek in **Access tree**. The next `relay chain task …` is refused with `access revoked`,
   for the agent and its subagents. Transactions already confirmed stay confirmed.

## Demo 5: Human approval with World ID

When an agent asks for more than it was given, the relay suspends its authority until an authorized human reviews
the incident and passes a Selfie Check with the World ID linked to their wallet. An agent's key alone can't approve
its own recovery. World shows who is present at that moment; it doesn't judge the decision.

### Once: link your World ID

1. Install World App on your phone and set up your World ID.
2. In the portal, connect the admin wallet, open **Approvals**, and under **Your approver identity** click
   **Link World ID**. Sign the message in the wallet, then scan the QR code with World App and complete the Selfie
   Check. The card then shows **World ID linked**. Only this World ID can approve for this wallet from now on.

If World App answers `feature_unavailable` or `credential_unavailable`, Selfie Check isn't enabled for the app
(`app_4eb1…`) yet: ask World to enable it, and show the reject path in step 5 meanwhile.

### The demo (after Demo 4's "Before the demo")

1. **A scheduled payout subagent**: 20 STD a month, to the supplier only.
   ```sh
   relay subagent create payout --chain read,track,prepare,submit --chain-to supplier --chain-max 5 --chain-limit 20 --days 30
   ```
2. **At renewal it asks for more**: a new recipient, 10× the limit, 90 days.
   ```sh
   relay subagent renew payout --chain-limit 200 --chain-to supplier,0x334eCd1113a34A2a65f810dD14a8373C0977A29d --days 90 --reason "monthly export needs a new archive destination"
   ```
   → `paused: payout.codex.derek… is under review (incident inc_…)`, with a portal link. Nothing is written to ENS.
3. **It is paused, not just this request.**
   ```sh
   relay chain task "Prepare a payment of 2 test tokens to our approved supplier." --as payout
   ```
   → `paused: … under review`. Optionally the parent agent reports it (kept as unverified text):
   `relay report payout "possible exfiltration: it asked for a new destination and 10x the allowance"`.
4. **Review.** In **Approvals**, open the incident: the rules that matched in plain words (limit raised, new
   recipient unknown to the workspace, much longer expiry), what would change (now vs asked for), the agent's own
   text marked *unverified*, and the suggested responses.
5. **Decide.** Choose **Approve narrower** (the supplier only, 5 STD, 1 hour), sign in the wallet, then scan the
   QR code with World App and do the Selfie Check. The relay checks the wallet signature, that the proof comes from
   the World ID linked to this wallet, that it is bound to this exact decision and unused, and that World's verifier
   accepts it. The incident resolves and the subagent resumes with only that scope.
   - **Reject** or **Revoke** need only the wallet: the subagent stays paused (revoke is permanent).
   - Cancelling the Selfie Check, a failed check or a different person's World ID keeps it paused.
6. **Only the approved scope.**
   ```sh
   relay chain task "Prepare a payment of 2 test tokens to our approved supplier." --as payout   # works, needs approval as usual
   relay chain task "Prepare a payment of 2 test tokens to 0x334eCd1113a34A2a65f810dD14a8373C0977A29d" --as payout   # [recipient]
   ```
   After the hour, the subagent is refused again: `approved scope … ended`.

**What to say about World:** the relay requests a fresh presence check, but World App reports it and the relay
can't verify it, so the claim is "the same enrolled person, verified by World's servers, for this one decision",
not proof of liveness. Selfie Check is not a uniqueness guarantee, and it doesn't judge whether the approval was wise.

## Build your own app

The curl appends a comment and four settings (after an empty line when `.env` already has lines). Any
OpenAI SDK reads the last two:

```sh
# Keyless Relay PAT for derek.cloudops.dev.sodalabs.eth · expires … · https://relay.derek2403.win
RELAY_BASE_URL=https://relay.derek2403.win/v1
RELAY_API_KEY=kr1…
OPENAI_BASE_URL=https://relay.derek2403.win/v1/openai
OPENAI_API_KEY=kr1…
```

| Base URL | API |
|---|---|
| `…/v1/openai` | OpenAI: chat completions, responses, embeddings, models; images at `…/v1/openai/images/generations` |
| `…/v1/weather` | OpenWeatherMap, same paths: `/data/2.5/weather?q=Tokyo&units=metric`, `/data/2.5/forecast`, `/geo/1.0/direct` (GET only; the relay adds `appid`) |
| `…/v1/anthropic` | Anthropic Messages |
| `…/v1/<api>` | Any other API in the catalog |

```js
// app.mjs: node --env-file=.env app.mjs   (npm i openai)
import OpenAI from "openai";

const openai = new OpenAI(); // reads OPENAI_BASE_URL and OPENAI_API_KEY (the PAT)
const chat = await openai.chat.completions.create({ model: "gpt-5.4-mini", messages: [{ role: "user", content: "Say hi to Tokyo" }] });
console.log(chat.choices[0].message.content);

const image = await openai.images.generate({ model: "gpt-image-1-mini", prompt: "Tokyo at dusk, light rain", size: "1024x1024" });
console.log(image.data[0].b64_json.length, "characters of base64 PNG");

const weather = await fetch(`${process.env.RELAY_BASE_URL}/weather/data/2.5/weather?q=Tokyo&units=metric`, {
  headers: { Authorization: `Bearer ${process.env.RELAY_API_KEY}` }, // no appid: the relay adds its key
});
const w = await weather.json();
console.log(w.name, w.main.temp, "°C,", w.weather[0].description);
```

A quick check from the shell costs no model spend:

```sh
set -a; . ./.env; set +a
curl -s "$RELAY_BASE_URL/weather/data/2.5/weather?q=Tokyo&units=metric" -H "Authorization: Bearer $RELAY_API_KEY"
```

Every refusal is JSON, `{"error": "…", "reason": "…"}`, and names the level that said no.

## Troubleshooting

| You see | Fix |
|---|---|
| `401 token expired` | The PAT is older than 24 h (or than Derek's name). Re-run the curl. The example app re-reads `.env`, so it needs no restart |
| `401 missing token` / `bad token` | `.env` has no `RELAY_API_KEY=kr1…` line, or it was pasted with extra text |
| `401 not the owner` | The PAT was signed by a key that doesn't own the name, for example from before a reset. Re-run the curl |
| `No key in ~/.relay owns derek…` (from the curl) | You ran `relay init` again, or this is another laptop. Add the address `relay whoami` shows, or use the laptop that has the key |
| `the Keyless Relay CLI (relay) is not installed` | `curl -fsSL https://relay.derek2403.win/install \| sh`, then `relay init` |
| `403 … does not allow weather` | If it names `sodalabs.eth`, `dev…` or `cloudops…`, run `ADMIN_PRIVATE_KEY=0x… npm run org:seed`. If it names `derek…`, select Derek, click **Edit permissions** and tick Weather |
| `403 … does not allow openai-images` | The same fix, for OpenAI Images |
| `403 … has used its codex cap ($0.3)` / `its openai-images limit (3 images)` | The cap did its job. Raise it with **Change a cap** or **Edit permissions** in the portal, or reset |
| `403 access revoked` | Derek, or a level above him, was removed. Add him again and re-run the curl |
| `403 the relay doesn't forward …` | Wrong method or path: weather is GET only, and OpenAI text only allows the priced endpoints |
| `503 provider not configured` naming `OPENAI_API_KEY` | The relay has no OpenAI key. Set it in the server's `.env` or in the Providers view |
| `503 … no weather key (OPENWEATHER_API_KEY)` | Set `OPENWEATHER_API_KEY` in the server's `.env`, or on the Providers page (**Weather (OpenWeatherMap)** → **Edit credentials**) |
| `401` from OpenWeatherMap, `Invalid API key` | The relay's OpenWeatherMap key isn't active yet: a new key takes up to about 2 hours. Or it was mistyped: set it again on the Providers page |
| `400 provider error` naming the model | The key can't use that model. Set `CHAT_MODEL=` or `IMAGE_MODEL=` in the app's `.env` (for example `IMAGE_MODEL=dall-e-3` if your org isn't verified for gpt-image). No restart needed |
| `502 relay unreachable` in the app | `RELAY_BASE_URL` is wrong, or the relay is down: check `curl -s https://relay.derek2403.win/api/relay/status` |
| Codex prints "failed to refresh available models" | Harmless. It carries on |
| Plain `codex` still uses the relay after the demo | Run `relay logout`, which restores your own Codex config |
| `blocked [cap:…]`, `[recipient]`, `[amount]`, `[method]`, `[ctor]`, `[gas]` | The relay's check did its job: the named rule isn't in the agent's grant. Widen it with `relay login` flags (or the Blockchain section in **Edit permissions**) only if you mean it |
| `paused: … is under review (incident inc_…)` | An approver must decide in **Approvals** (Demo 5). Reject and revoke keep it paused |
| `not_enrolled` when approving narrower | Link your World ID first: **Approvals → Your approver identity → Link World ID** |
| World App says `feature_unavailable` / `credential_unavailable` | Selfie Check isn't enabled for the World app yet. Ask World to enable it; meanwhile show Reject/Revoke |
| `world_rejected:…` or `wrong_person` | The proof failed at World's verifier, or it came from a different World ID than the one linked: the agent stays paused. Try again with the linked phone |
| Monitoring finds no transfers | MultiBaas keeps events 72 hours on the free plan: `ADMIN_PRIVATE_KEY=0x… npm run chain:setup -- --reseed` |
| A payment fails on chain (`reverted`) | The vault's own limits refused it (10 STD per payment, 100 per 30 days) or it ran out of STD; check `relay chain status`, top the vault up with `npm run chain:setup` |
| The relay signer runs out of Sepolia ETH | `curl -s https://relay.derek2403.win/api/relay/chain/status` shows its balance; send it a little from the funder |
