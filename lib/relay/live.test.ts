// Live kill: a name removed while its response streams is cut off within one
// check interval, with a provider-style error event, and charged what it used.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { LiveChecker } from "./live";
import { decide } from "./policy";
import { KILLED_REASON, clientStream } from "./providers";
import { MemoryChain, bundle, fakeUpstream, level, makeDeps, relay, tokenFor, waitForLog } from "./testkit";

const INTERVAL_MS = 150;
const SLACK_MS = 400;

const openaiEvent = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

let up: Awaited<ReturnType<typeof fakeUpstream>>;
const upstreamClosed: string[] = [];
before(async () => {
  up = await fakeUpstream((req, res) => {
    const url = req.url!.split("?")[0];
    const tick = (write: () => void, max = 250) => {
      let n = 0;
      const t = setInterval(() => {
        if (res.destroyed || ++n > max) {
          clearInterval(t);
          if (!res.destroyed) res.end();
          return;
        }
        write();
      }, 40);
      res.on("close", () => {
        clearInterval(t);
        if (!res.writableFinished) upstreamClosed.push(url);
      });
    };
    if (url === "/v1/responses") {
      const start = () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(openaiEvent("response.created", { response: { id: "resp_1", model: "gpt-5" } }));
        tick(() => res.write(openaiEvent("response.output_text.delta", { delta: "word " })));
      };
      if (req.headers["x-test"] === "slow-headers") return void setTimeout(() => !res.destroyed && start(), 3000);
      return start();
    }
    if (url === "/v1/messages") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: "claude-sonnet-4-6", usage: { input_tokens: 1000, output_tokens: 1 } } })}\n\n`);
      return tick(() => res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "word " } })}\n\n`));
    }
    // Any other path: a slow plain (non-SSE) body.
    res.writeHead(200, { "content-type": "application/json" });
    res.write("[");
    tick(() => res.write('"chunk",'));
  });
});
after(() => up.close());

const agent = privateKeyToAccount(generatePrivateKey());
const admin = privateKeyToAccount(generatePrivateKey());
const USER = "derek.dev.acme.eth";
const AGENT = `codex.${USER}`;
const ALL = "codex,claude,vercel";

function setup() {
  const chain = new MemoryChain([
    level("acme.eth", admin.address, bundle(ALL, { caps: { codex: 100, claude: 100 } })),
    level("dev.acme.eth", admin.address, bundle(ALL)),
    level(USER, admin.address, bundle(ALL, { caps: { codex: 20 } })),
    level(AGENT, agent.address, bundle(ALL, { caps: { codex: 5 }, period: "total" })),
  ]);
  const d = makeDeps(chain, {
    OPENAI_API_KEY: "sk-proj-OPENAI-0123456789",
    ANTHROPIC_API_KEY: "sk-ant-api03-CLAUDE-0123456789",
    VERCEL_TOKEN: "vercel_REAL_0123456789",
    RELAY_UPSTREAM_CODEX: up.url,
    RELAY_UPSTREAM_CLAUDE: up.url,
    RELAY_UPSTREAM_VERCEL: up.url,
  });
  d.live = new LiveChecker(chain, INTERVAL_MS);
  return { chain, d };
}

const decoder = new TextDecoder();

/** Reads until `until(text)` holds, then returns the reader and the text so far. */
async function readUntil(body: ReadableStream<Uint8Array>, until: (text: string) => boolean) {
  const reader = body.getReader();
  let text = "";
  while (!until(text)) {
    const { value, done } = await reader.read();
    assert.ok(!done, "the stream ended too early");
    text += decoder.decode(value, { stream: true });
  }
  return { reader, text };
}

async function readRest(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
}

const lastEvent = (text: string) => {
  const events = text.trim().split(/\n\n/);
  const block = events[events.length - 1];
  const event = block.match(/^event: (.*)$/m)?.[1];
  const data = JSON.parse(block.match(/^data: (.*)$/m)![1]);
  return { event, data };
};

test("live kill: an OpenAI Responses stream ends with an error event within one interval, and the partial usage is charged", async () => {
  const { chain, d } = setup();
  const kr = await tokenFor(agent, AGENT);
  const res = await relay(d, "codex", "/v1/responses", { kr, body: { model: "gpt-5", input: "write a lot", stream: true, max_output_tokens: 2000 } });
  assert.equal(res.status, 200);
  const { reader, text: head } = await readUntil(res.body!, (t) => (t.match(/output_text\.delta/g) ?? []).length >= 3);

  const removedAt = Date.now();
  chain.remove(USER);
  const rest = await readRest(reader);
  const took = Date.now() - removedAt;
  assert.ok(took < INTERVAL_MS + SLACK_MS, `closed ${took} ms after the removal`);

  const { event, data } = lastEvent(head + rest);
  assert.equal(event, "error");
  assert.equal(data.type, "error");
  assert.equal(data.error.message, "access revoked: derek.dev.acme.eth was removed or expired. Run ./relay login.");
  assert.ok(!(head + rest).includes("sk-proj-OPENAI"));

  const [entry] = await waitForLog(d.meter);
  assert.equal(entry.reason, KILLED_REASON);
  assert.equal(entry.allowed, true);
  assert.equal(entry.status, 200);
  assert.equal(entry.estimated, true);
  assert.ok((entry.costUsd ?? 0) > 0, "what streamed so far is charged");
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(upstreamClosed.includes("/v1/responses"), "the provider call was stopped");

  chain.restore(USER);
  const p = await decide({ name: AGENT, provider: "codex" }, d);
  assert.ok(p.levels.every((l) => Math.abs((l.spent.codex ?? 0) - entry.costUsd!) < 1e-9), "every level was charged");
});

test("live kill: a Claude stream ends with Anthropic's permission_error event", async () => {
  const { chain, d } = setup();
  const res = await relay(d, "claude", "/v1/messages", { kr: await tokenFor(agent, AGENT), body: { model: "claude-sonnet-4-6", max_tokens: 1000, stream: true } });
  const { reader, text: head } = await readUntil(res.body!, (t) => t.includes("content_block_delta"));
  chain.remove(AGENT);
  const { event, data } = lastEvent(head + (await readRest(reader)));
  assert.equal(event, "error");
  assert.deepEqual(data, { type: "error", error: { type: "permission_error", message: `access revoked: ${AGENT} was removed or expired. Run ./relay login.` } });
  const [entry] = await waitForLog(d.meter);
  assert.equal(entry.reason, KILLED_REASON);
  // 1000 input tokens seen + streamed text, at Sonnet 4.6 prices.
  assert.ok((entry.costUsd ?? 0) >= (1000 * 3) / 1e6);
});

test("live kill: a plain (non-SSE) body is aborted; the request still counts", async () => {
  const { chain, d } = setup();
  const res = await relay(d, "vercel", "/v9/projects", { kr: await tokenFor(agent, AGENT) });
  assert.equal(res.status, 200);
  const { reader } = await readUntil(res.body!, (t) => t.includes("chunk"));
  const removedAt = Date.now();
  chain.remove(USER);
  await assert.rejects(readRest(reader));
  assert.ok(Date.now() - removedAt < INTERVAL_MS + SLACK_MS);
  const [entry] = await waitForLog(d.meter);
  assert.equal(entry.reason, KILLED_REASON);
  chain.restore(USER);
  assert.equal((await decide({ name: AGENT, provider: "vercel" }, d)).levels[3].used?.vercel, 1);
});

test("live kill: removal before the provider answers aborts the call with 403 access revoked", async () => {
  const { chain, d } = setup();
  setTimeout(() => chain.remove(USER), 100);
  const started = Date.now();
  const res = await relay(d, "codex", "/v1/responses", {
    kr: await tokenFor(agent, AGENT),
    body: { model: "gpt-5", input: "hi", stream: true, max_output_tokens: 100 },
    headers: { "x-test": "slow-headers" },
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, "access revoked");
  assert.equal(body.reason, "access revoked: derek.dev.acme.eth was removed or expired. Run ./relay login.");
  assert.ok(Date.now() - started < 100 + INTERVAL_MS + SLACK_MS);
  const [entry] = await waitForLog(d.meter);
  assert.equal(entry.reason, KILLED_REASON);
});

test("live checks are shared per name: two streams cost one chain read per interval", async () => {
  const { chain, d } = setup();
  const kr = await tokenFor(agent, AGENT);
  const body = { model: "gpt-5", input: "hi", stream: true, max_output_tokens: 2000 };
  const [a, b] = await Promise.all([relay(d, "codex", "/v1/responses", { kr, body }), relay(d, "codex", "/v1/responses", { kr, body })]);
  const readsBefore = chain.reads;
  const readers = [a, b].map((r) => r.body!.getReader());
  const drain = readers.map((r) => readRest(r).catch(() => ""));
  await new Promise((r) => setTimeout(r, INTERVAL_MS * 4 + 50));
  const reads = chain.reads - readsBefore;
  assert.ok(reads >= 3 && reads <= 5, `${reads} reads for 2 streams over 4 intervals`);
  chain.remove(AGENT);
  const texts = await Promise.all(drain);
  assert.ok(texts.every((t) => t.includes("access revoked")), "both streams were ended");
  assert.equal((d.live as LiveChecker).watching, 0, "nothing left to watch");
});

test("clientStream: a kill mid-event waits for the event to finish, then sends the final event; no boundary in time aborts", async () => {
  const enc = new TextEncoder();
  const run = async (chunks: string[], killAfter: number, waitMs: number) => {
    const out = clientStream(null, {}, waitMs);
    const writer = out.stream.writable.getWriter();
    const reading = readRest(out.stream.readable.getReader());
    let afterRan = false;
    for (let i = 0; i < chunks.length; i++) {
      if (i === killAfter) out.kill("event: error\ndata: {}\n\n", () => (afterRan = true));
      await writer.write(enc.encode(chunks[i])).catch(() => {});
      await new Promise((r) => setTimeout(r, 20));
    }
    return { text: await reading.catch(() => null), afterRan };
  };
  const clean = await run(['data: {"a":', '1}\n\ndata: {"b":2}\n\n'], 1, 500);
  assert.deepEqual(clean, { text: 'data: {"a":1}\n\nevent: error\ndata: {}\n\n', afterRan: true });
  const stuck = await run(['data: {"a":', "1}"], 1, 30);
  assert.equal(stuck.text, null, "aborted instead of sending half an event");
  assert.equal(stuck.afterRan, true);
});
