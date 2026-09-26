# Weather to Image

A small OpenAI-style app: you type *"Get the weather of Tokyo today and generate an image based on it"*,
the LLM calls a weather tool and an image tool, and the page shows each call as it happens, then the
image and the answer. All three APIs go through Keyless Relay with **one PAT**, a token for your ENS
name. The app never holds an OpenAI or OpenWeatherMap key: both live on the relay.

| Call | Relay URL |
|---|---|
| LLM (Chat Completions, tool calling) | `POST https://relay.derek2403.win/v1/openai/chat/completions` |
| Weather (OpenWeatherMap) | `GET https://relay.derek2403.win/v1/weather/data/2.5/weather?q=Tokyo&units=metric` (the relay adds `appid`) |
| Image (OpenAI Images) | `POST https://relay.derek2403.win/v1/openai/images/generations` |

The relay URL is set in `server.mjs` (`RELAY_BASE_URL`); `.env` only holds the PAT.

No dependencies: Node.js 20 or newer. You need the `relay` CLI with a key that owns your ENS name
(`relay init`, then your admin adds you). The relay needs `OPENWEATHER_API_KEY`: in its `.env`, or set by the
root owner on the Providers page (**Weather (OpenWeatherMap)** → **Edit credentials**).

## Run it

1. **Get a PAT into `.env`.** The relay's `/pat` script runs your local `relay` CLI, which signs the
   token with your key:
   ```sh
   cd examples/weather-image-app
   curl -fsSL "https://relay.derek2403.win/pat?name=derek.cloudops.dev.sodalabs.eth" | sh >> .env
   ```
2. **Start the app:**
   ```sh
   node server.mjs
   ```
3. **Open http://localhost:5173** and click **Ask**.

`.env` then holds one PAT (it is gitignored, so it can't be committed):

```sh
# Keyless Relay PAT for derek.cloudops.dev.sodalabs.eth · expires … · https://relay.derek2403.win
RELAY_PAT=kr1…
```

A PAT lasts up to 24 hours (`&hours=N` asks for less). To refresh it, run the curl again: the newest line
wins, and the app reads `.env` on every request, so it doesn't need a restart.

Optional settings in `.env`: `CHAT_MODEL` (default `gpt-5.4-mini`), `IMAGE_MODEL` (default
`gpt-image-1-mini`) and `PORT` (default 5173). The server listens on 127.0.0.1 only, because anyone who can
reach it can spend your PAT.

## When the relay says no

The relay checks your ENS name's limits on every call. When it refuses one, the page shows its status and
reason in red. For example:
- `401 token expired`: the PAT is too old. Run the curl again.
- `403 denied · … has used its openai-images limit (3 images)`: you reached the image cap.
- `403 access revoked · … was removed or expired`: your admin removed your name.
- `503 provider not configured · The relay has no weather key (OPENWEATHER_API_KEY)`: set the key on the relay.
- `401 provider error: Invalid API key`: OpenWeatherMap doesn't accept the relay's key yet. A new key can take
  up to about 2 hours to activate.

A refused tool call is also passed to the model, so its answer says what went wrong.
