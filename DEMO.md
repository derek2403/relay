# Demo runbook

Two stage demos on **https://relay.derek2403.win**, with the company `sodalabs.eth` on ENSv2 Sepolia.

1. **Codex with an ENS identity.** Derek gets a name instead of an API key. Codex runs as its own name, makes
   subagents, hits its budget, and stops within seconds when Derek is removed.
2. **One PAT for LLM + weather + images.** One `curl` puts a token for Derek's ENS name into an app's `.env`.
   A small OpenAI-style web app then uses the LLM, a weather API and image generation with that one token.

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
   `gpt-5.4-mini` at GPT-5 rates, and images at $0.04 each. Weather (Open-Meteo) is free.

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
   - tick **OpenAI text (Codex)** `$2`, **OpenAI Images** `3` and **Weather (Open-Meteo)** `20`

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
   curl -s "$RELAY_BASE_URL/weather/forecast?latitude=35.68&longitude=139.69&current=temperature_2m" -H "Authorization: Bearer $RELAY_API_KEY"
   ```
   It prints Tokyo's temperature. `does not allow weather` means setup step 3 hasn't run.
2. **Start the app:**
   ```sh
   node server.mjs
   ```
   It prints `http://localhost:5173  ·  PAT for derek.cloudops.dev.sodalabs.eth via https://relay.derek2403.win/v1`.
3. Open **http://localhost:5173** and click **Ask**. The prompt is already filled in: *Get the weather of Tokyo
   today and generate an image based on it*. The page adds a row for each call as it happens:
   **LLM**, **get_weather** (Tokyo's temperature, feels-like, conditions, wind and rain), **LLM**,
   **generate_image**, then the image and the answer.
4. **"Three APIs, one PAT, no provider key in the app."** In the portal, select `derek`. The Live view lists
   the calls, all made as `derek.cloudops.dev.sodalabs.eth`: `codex` (chat completions), `weather` and
   `openai-images`. Spend and counts rise on Derek, cloudops, dev and sodalabs.eth.
5. **Optional, the image cap:** click **Ask** again until the **generate_image** row turns red:
   `403 denied: derek.cloudops.dev.sodalabs.eth has used its openai-images limit (3 images)`. The model's answer
   explains why. If you kept Derek from Demo 1, the images Codex made there count toward the 3.
6. **Revoke:** in the portal, select `derek`, click **Remove derek.cloudops.dev.sodalabs.eth**, then **Yes,
   remove it**. Click **Ask**: the first call is refused with `403 access revoked`.
7. **Afterwards:** `rm .env`, then run the reset.

**Combined finale:** run Demo 2 steps 1 to 4 right after Demo 1 step 6. Codex's agent is out of budget, but
Derek himself still has budget, so the web app keeps working. One **Remove** then stops Codex, its subagents
and the web app together.

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
| `…/v1/weather` | Open-Meteo: `/forecast?latitude=…&longitude=…&current=…` (GET only) |
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

const weather = await fetch(`${process.env.RELAY_BASE_URL}/weather/forecast?latitude=35.68&longitude=139.69&current=temperature_2m,weather_code`, {
  headers: { Authorization: `Bearer ${process.env.RELAY_API_KEY}` },
});
console.log((await weather.json()).current);
```

A quick check from the shell costs no model spend:

```sh
set -a; . ./.env; set +a
curl -s "$RELAY_BASE_URL/weather/forecast?latitude=35.68&longitude=139.69&current=temperature_2m" -H "Authorization: Bearer $RELAY_API_KEY"
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
| `503 provider not configured` | The relay has no `OPENAI_API_KEY`. Set it in the server's `.env` or in the Providers view |
| `400 provider error` naming the model | The key can't use that model. Set `CHAT_MODEL=` or `IMAGE_MODEL=` in the app's `.env` (for example `IMAGE_MODEL=dall-e-3` if your org isn't verified for gpt-image). No restart needed |
| `502 relay unreachable` in the app | `RELAY_BASE_URL` is wrong, or the relay is down: check `curl -s https://relay.derek2403.win/api/relay/status` |
| Codex prints "failed to refresh available models" | Harmless. It carries on |
| Plain `codex` still uses the relay after the demo | Run `relay logout`, which restores your own Codex config |
