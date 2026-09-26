// Weather → image, an OpenAI-style app on Keyless Relay.
//
// One PAT (a kr1 token for your ENS name, from the relay's /pat curl) pays for all three APIs:
//   the LLM     POST ${RELAY_BASE_URL}/openai/chat/completions     (OpenAI Chat Completions, tool calling)
//   weather     GET  ${RELAY_BASE_URL}/weather/data/2.5/weather?q=… (OpenWeatherMap)
//   the image   POST ${RELAY_BASE_URL}/openai/images/generations   (OpenAI Images)
// The relay checks your ENS name's limits on every call and attaches the real keys (OpenAI's, and
// OpenWeatherMap's ?appid=); this app never sees one.
//
// No dependencies (Node 20+): node server.mjs, then open http://localhost:5173

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const MAX_ROUNDS = 6;

/** Settings from .env next to this file (read on every request, so re-running the curl needs no restart). */
function config() {
  const env = { ...process.env };
  try {
    for (const line of fs.readFileSync(path.join(DIR, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2"); // a later line wins
    }
  } catch {}
  const base = env.RELAY_BASE_URL || env.OPENAI_BASE_URL?.replace(/\/openai\/?$/, "") || "";
  return {
    base: base.replace(/\/+$/, ""),
    key: env.RELAY_API_KEY || env.OPENAI_API_KEY || "",
    chatModel: env.CHAT_MODEL || "gpt-5.4-mini",
    imageModel: env.IMAGE_MODEL || "gpt-image-1-mini",
    port: Number(env.PORT) || 5173,
  };
}
const PORT = config().port;

/** A relay error as the page shows it: the relay's own { error, reason }. */
const refusal = (status, error, reason) => Object.assign(new Error(reason), { status, error, reason });

/** One call through the relay with the PAT. Anything but 2xx throws the relay's refusal. */
async function relay(cfg, route, body) {
  let res;
  try {
    res = await fetch(cfg.base + route, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${cfg.key}`, ...(body && { "content-type": "application/json" }) },
      body: body && JSON.stringify(body),
    });
  } catch (err) {
    throw refusal(502, "relay unreachable", `${cfg.base}: ${err.cause?.code ?? err.message}`);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (!res.ok) {
    // The relay answers { error, reason }. Provider errors pass through: OpenAI's { error: { message } },
    // OpenWeatherMap's { cod, message } (e.g. 401 "Invalid API key", 404 "city not found").
    const upstream = typeof data.error === "object" ? data.error?.message : data.error ? null : data.message;
    throw refusal(res.status, upstream ? "provider error" : String(data.error || res.statusText), data.reason || upstream || text.slice(0, 300));
  }
  return data;
}

// --- The two tools ---------------------------------------------------------------------------

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Current weather for a city.",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: 'City name, optionally with a country code: "Tokyo" or "London,GB"' } },
        required: ["city"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description: "Generate one 1024x1024 image. The user sees it right away.",
      parameters: {
        type: "object",
        properties: { prompt: { type: "string", description: "A detailed image prompt" } },
        required: ["prompt"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
];

// OpenWeatherMap's current weather, in °C (units=metric). The relay adds the key.
async function getWeather(cfg, { city }) {
  const w = await relay(cfg, `/weather/data/2.5/weather?${new URLSearchParams({ q: city, units: "metric" })}`);
  const weather = {
    city: w.name || city,
    local_time: new Date((w.dt + w.timezone) * 1000).toISOString().slice(11, 16), // dt and timezone are in seconds
    conditions: w.weather?.[0]?.description ?? "unknown",
    temperature: `${w.main.temp} °C`,
    feels_like: `${w.main.feels_like} °C`,
    humidity: `${w.main.humidity} %`,
    wind: `${w.wind.speed} m/s`,
    clouds: `${w.clouds.all} %`,
  };
  const summary = `${weather.city}: ${weather.temperature} (feels ${weather.feels_like}), ${weather.conditions}, humidity ${weather.humidity}, wind ${weather.wind}`;
  return { forModel: weather, summary };
}

async function generateImage(cfg, { prompt }) {
  const { data } = await relay(cfg, "/openai/images/generations", { model: cfg.imageModel, prompt, size: "1024x1024", n: 1 });
  const src = data[0].b64_json ? `data:image/png;base64,${data[0].b64_json}` : data[0].url;
  // The model gets a note, not the image: base64 would cost thousands of tokens.
  return { forModel: { shown_to_user: true }, summary: "1 image, 1024x1024", src };
}

// --- The tool loop -----------------------------------------------------------------------------

const SYSTEM =
  "You are a concise assistant. For weather, call get_weather with the city's name. " +
  "For an image, first get the real weather, then call generate_image with a vivid prompt that shows it " +
  "(conditions, temperature, time of day, the city's landmarks). Finish with two or three sentences that quote the numbers.";

/** Runs the prompt, calling `send` for each step (the page shows them as they happen). */
async function run(cfg, prompt, send) {
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: prompt },
  ];
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const reply = await relay(cfg, "/openai/chat/completions", { model: cfg.chatModel, messages, tools: TOOLS });
    const msg = reply.choices[0].message;
    messages.push(msg);
    send({ type: "llm", model: reply.model, tokens: reply.usage?.total_tokens, calls: msg.tool_calls?.length ?? 0 });
    if (!msg.tool_calls?.length) return send({ type: "answer", text: msg.content });

    for (const call of msg.tool_calls) {
      const { name } = call.function;
      const args = JSON.parse(call.function.arguments || "{}");
      send({ type: "call", id: call.id, name, args });
      let content;
      try {
        const tool = name === "get_weather" ? getWeather : name === "generate_image" ? generateImage : null;
        if (!tool) throw refusal(400, "unknown tool", name);
        const result = await tool(cfg, args);
        send({ type: "result", id: call.id, summary: result.summary, src: result.src });
        content = result.forModel;
      } catch (err) {
        // A refused tool (a cap reached, access revoked, …) is shown, and the model is told why.
        send({ type: "refused", id: call.id, status: err.status ?? 500, error: err.error ?? "error", reason: err.reason ?? err.message });
        content = { error: `the relay refused this call: ${err.reason ?? err.message}` };
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(content) });
    }
  }
  send({ type: "answer", text: `(stopped after ${MAX_ROUNDS} rounds of tool calls)` });
}

// --- HTTP ----------------------------------------------------------------------------------------

/** Who the PAT is for, read from the token itself (kr1.<base64url JSON>.<signature>). */
function whoami(cfg) {
  try {
    const { name, exp } = JSON.parse(Buffer.from(cfg.key.split(".")[1], "base64url").toString());
    return { name, expires: new Date(exp * 1000).toISOString(), relay: cfg.base };
  } catch {
    return { name: null, relay: cfg.base || null };
  }
}

async function ask(req, res) {
  let body = "";
  for await (const chunk of req) if ((body += chunk).length > 64_000) return res.writeHead(413).end();
  const cfg = config();
  // Steps stream as NDJSON; an error before the first step is a plain JSON response with the relay's status.
  const send = (event) => {
    if (!res.headersSent) res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
    res.write(`${JSON.stringify(event)}\n`);
  };
  try {
    const prompt = String(JSON.parse(body || "{}").prompt ?? "").trim();
    if (!cfg.base || !cfg.key) throw refusal(500, "no PAT", "Put RELAY_BASE_URL and RELAY_API_KEY in examples/weather-image-app/.env (see README.md).");
    if (!prompt) throw refusal(400, "empty prompt", "Type a prompt.");
    await run(cfg, prompt, send);
  } catch (err) {
    const error = { type: "error", status: err.status ?? 500, error: err.error ?? "error", reason: err.reason ?? err.message };
    if (res.headersSent) send(error);
    else res.writeHead(error.status, { "content-type": "application/json" }).write(JSON.stringify(error));
  }
  res.end();
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return fs.createReadStream(path.join(DIR, "index.html")).pipe(res);
  }
  if (req.method === "GET" && req.url === "/api/whoami") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(whoami(config())));
  }
  // JSON only: a page on another site can't send that without a preflight, so it can't spend your PAT.
  if (req.method === "POST" && req.url === "/api/ask" && req.headers["content-type"]?.startsWith("application/json")) {
    return ask(req, res).catch((err) => res.destroy(err));
  }
  res.writeHead(404, { "content-type": "text/plain" }).end("not found");
});

// Loopback only: this server spends your PAT for whoever can reach it.
server.listen(PORT, "127.0.0.1", () => {
  const cfg = config();
  const { name } = whoami(cfg);
  const who = name ? `PAT for ${name}` : cfg.key ? "the key in .env is not a PAT" : "no PAT in .env yet (see README.md)";
  console.log(`http://localhost:${PORT}  ·  ${who}${cfg.base ? ` via ${cfg.base}` : ""}`);
});
