import assert from "node:assert/strict";
import { test } from "node:test";

import { UsageTracker, claudeCostUsd, claudePrice, codexCostUsd, codexPrice } from "./pricing";

const enc = new TextEncoder();
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

/** Feeds text to a tracker in chunks of `size` bytes (splits UTF-8 sequences and SSE lines on purpose). */
function feed(tracker: UsageTracker, text: string, size = 7) {
  const bytes = enc.encode(text);
  for (let i = 0; i < bytes.length; i += size) tracker.push(bytes.subarray(i, i + size));
}

const sse = (events: [string | null, unknown][], eol = "\n") =>
  events.map(([event, data]) => `${event ? `event: ${event}${eol}` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}${eol}${eol}`).join("");

// --- Prices ---------------------------------------------------------------------

test("claudePrice: exact, dated and aliased ids; longest match wins; unknown is the most expensive", () => {
  assert.deepEqual(claudePrice("claude-sonnet-4-6"), { price: { input: 3, output: 15 }, known: true });
  assert.equal(claudePrice("claude-haiku-4-5-20251001").price.input, 1);
  assert.equal(claudePrice("claude-sonnet-4-6[1m]").price.input, 3);
  assert.equal(claudePrice("claude-fable-5-1").price.cacheRead, 0.25);
  assert.equal(claudePrice("claude-fable-5").price.cacheRead, 1);
  assert.equal(claudePrice("claude-opus-5-5").price.input, 4);
  assert.deepEqual(claudePrice("claude-3-haiku-20240307"), { price: { input: 10, output: 50, cacheRead: 1 }, known: false });
  assert.equal(claudePrice(null).known, false);
});

test("claudeCostUsd: input, output, cache writes (5m/1h or flat 1.25x), cache reads, fast mode", () => {
  // Sonnet 4.6: 3/15, cache read 0.1x input.
  close(
    claudeCostUsd("claude-sonnet-4-6", { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10_000 }),
    (1000 * 3 + 2000 * 3 * 1.25 + 10_000 * 0.3 + 500 * 15) / 1e6,
  );
  // Split cache writes take precedence over cache_creation_input_tokens.
  close(
    claudeCostUsd("claude-sonnet-4-6", {
      cache_creation_input_tokens: 2000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 1000 },
    }),
    (1000 * 3 * 1.25 + 1000 * 3 * 2) / 1e6,
  );
  // Listed cache-read price (Opus 5.5: 0.20) and fast mode 2x.
  close(claudeCostUsd("claude-opus-5-5", { input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 10 }), (100 * 4 + 1000 * 0.2 + 10 * 20) / 1e6);
  close(claudeCostUsd("claude-opus-5", { input_tokens: 1000, output_tokens: 1000, speed: "fast" }), ((1000 * 5 + 1000 * 25) / 1e6) * 2);
});

test("codexPrice: configured exact/prefix/wildcard prices, else the built-in estimate, else the labelled placeholder", () => {
  const prices = { "gpt-5": [1.25, 10, 0.125] as [number, number, number], "gpt-5-mini": [0.25, 2] as [number, number] };
  assert.deepEqual(codexPrice("gpt-5-mini", prices), { price: [0.25, 2, 0.25], known: true, source: "configured" });
  assert.deepEqual(codexPrice("gpt-5-2026-01-01", prices).price, [1.25, 10, 0.125]);
  assert.deepEqual(codexPrice("o9", prices), { price: [5, 20, 5], known: false, source: "placeholder" });
  assert.deepEqual(codexPrice("o9", { "*": [1, 2] }).price, [1, 2, 1]);
  // Estimates (not configured): exact, then the longest prefix.
  assert.deepEqual(codexPrice("gpt-5.1-codex", {}), { price: [1.25, 10, 0.125], known: false, source: "estimate" });
  assert.deepEqual(codexPrice("gpt-5-mini-2025-08-07", {}).price, [0.25, 2, 0.025]);
  assert.deepEqual(codexPrice("o3-pro", {}).price, [20, 80, 20]);
  assert.equal(codexPrice(null, {}).source, "placeholder");
  assert.equal(codexPrice("gpt-5", { "*": [9, 9] }).source, "configured", "RELAY_CODEX_PRICES always wins");
  close(codexCostUsd("gpt-5", { input: 1000, output: 100, cached: 400 }, prices), (600 * 1.25 + 400 * 0.125 + 100 * 10) / 1e6);
});

// --- Anthropic --------------------------------------------------------------------

test("anthropic JSON body", () => {
  const t = new UsageTracker("anthropic", "application/json");
  feed(t, JSON.stringify({ id: "m", type: "message", model: "claude-sonnet-4-6", content: [{ type: "text", text: "héllo ✓" }], usage: { input_tokens: 1000, output_tokens: 500 } }));
  const r = t.finish({ aborted: false, status: 200 });
  assert.equal(r.estimated, false);
  assert.equal(r.model, "claude-sonnet-4-6");
  close(r.usd, (1000 * 3 + 500 * 15) / 1e6);
});

const anthropicStream = (withFinal: boolean) =>
  sse([
    ["message_start", { type: "message_start", message: { id: "m", type: "message", model: "claude-haiku-4-5", usage: { input_tokens: 2000, cache_read_input_tokens: 1000, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["ping", { type: "ping" }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello wörld, " } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "how are you?" } }],
    ...(withFinal
      ? ([
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 15 } }],
          ["message_delta", { type: "message_delta", delta: {}, usage: { output_tokens: 40 } }],
          ["message_stop", { type: "message_stop" }],
        ] as [string, unknown][])
      : []),
  ]);

test("anthropic SSE: input from message_start, last cumulative output_tokens from message_delta", () => {
  for (const size of [1, 3, 64, 100_000]) {
    const t = new UsageTracker("anthropic", "text/event-stream; charset=utf-8");
    feed(t, anthropicStream(true), size);
    const r = t.finish({ aborted: false, status: 200 });
    assert.equal(r.estimated, false, `chunk ${size}`);
    close(r.usd, (2000 * 1 + 1000 * 0.1 + 40 * 5) / 1e6);
    assert.equal(r.outputTokens, 40);
  }
});

test("anthropic SSE: CRLF line endings and input counts repeated in message_delta", () => {
  const body = sse(
    [
      ["message_start", { type: "message_start", message: { model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 1 } } }],
      ["message_delta", { type: "message_delta", usage: { input_tokens: 1200, output_tokens: 30, cache_read_input_tokens: null } }],
    ],
    "\r\n",
  );
  const t = new UsageTracker("anthropic", "text/event-stream");
  feed(t, body, 5);
  const r = t.finish({ aborted: false, status: 200 });
  close(r.usd, (1200 * 3 + 30 * 15) / 1e6);
});

test("anthropic SSE cut short: estimate = input seen + chars/4 of streamed text", () => {
  const t = new UsageTracker("anthropic", "text/event-stream");
  feed(t, anthropicStream(false));
  const r = t.finish({ aborted: true, status: 200 });
  assert.equal(r.estimated, true);
  const chars = "Hello wörld, how are you?".length; // 25 -> 7 tokens
  close(r.usd, (2000 * 1 + 1000 * 0.1 + Math.ceil(chars / 4) * 5) / 1e6);
});

test("no usage: complete JSON without usage and error responses cost nothing", () => {
  const list = new UsageTracker("anthropic", "application/json", { requestModel: null });
  feed(list, JSON.stringify({ data: [{ id: "claude-sonnet-4-6" }], has_more: false }));
  assert.deepEqual(list.finish({ aborted: false, status: 200 }), { usd: 0, estimated: false, model: null, inputTokens: 0, outputTokens: 0 });

  const err = new UsageTracker("anthropic", "application/json", { requestModel: "claude-sonnet-4-6" });
  feed(err, JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
  assert.equal(err.finish({ aborted: false, status: 529 }).usd, 0);

  const sseErr = new UsageTracker("anthropic", "text/event-stream");
  feed(sseErr, sse([["error", { type: "error", error: { type: "overloaded_error" } }]]));
  assert.equal(sseErr.finish({ aborted: false, status: 200 }).usd, 0);
});

test("cut-off JSON body of a generation request is estimated from the bytes received", () => {
  const t = new UsageTracker("anthropic", "application/json", { requestModel: "claude-sonnet-4-6" });
  const partial = '{"id":"m","type":"message","content":[{"type":"text","text":"abcdefgh';
  feed(t, partial);
  const r = t.finish({ aborted: true, status: 200 });
  assert.equal(r.estimated, true);
  close(r.usd, (Math.ceil(partial.length / 4) * 15) / 1e6);
});

// --- OpenAI -----------------------------------------------------------------------

const PRICES = { "gpt-5": [1.25, 10, 0.125] as [number, number, number] };

test("openai chat completions JSON", () => {
  const t = new UsageTracker("openai", "application/json", { codexPrices: PRICES });
  feed(t, JSON.stringify({ object: "chat.completion", model: "gpt-5-2026-01-01", choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 400 } } }));
  const r = t.finish({ aborted: false, status: 200 });
  assert.equal(r.estimated, false);
  close(r.usd, (600 * 1.25 + 400 * 0.125 + 100 * 10) / 1e6);
});

test("openai chat completions SSE: usage on the final chunk (stream_options.include_usage)", () => {
  const body = sse([
    [null, { object: "chat.completion.chunk", model: "gpt-5", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }],
    [null, { object: "chat.completion.chunk", model: "gpt-5", choices: [{ index: 0, delta: { content: "Hello" } }] }],
    [null, { object: "chat.completion.chunk", model: "gpt-5", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }],
    [null, { object: "chat.completion.chunk", model: "gpt-5", choices: [], usage: { prompt_tokens: 50, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } }],
    [null, "[DONE]"],
  ]);
  const t = new UsageTracker("openai", "text/event-stream", { codexPrices: PRICES });
  feed(t, body, 11);
  const r = t.finish({ aborted: false, status: 200 });
  assert.equal(r.estimated, false);
  close(r.usd, (50 * 1.25 + 5 * 10) / 1e6);
});

test("openai chat completions SSE without usage is estimated from streamed text (placeholder price)", () => {
  const body = sse([
    [null, { object: "chat.completion.chunk", model: "unknown-model", choices: [{ delta: { content: "12345678" } }] }],
    [null, { object: "chat.completion.chunk", model: "unknown-model", choices: [{ delta: { tool_calls: [{ function: { arguments: "{\"a\":1}" } }] } }] }],
    [null, "[DONE]"],
  ]);
  const t = new UsageTracker("openai", "text/event-stream", { codexPrices: PRICES });
  feed(t, body);
  const r = t.finish({ aborted: false, status: 200 });
  assert.equal(r.estimated, true);
  close(r.usd, (Math.ceil(15 / 4) * 20) / 1e6); // placeholder [5, 20]
});

test("openai responses JSON", () => {
  const t = new UsageTracker("openai", "application/json", { codexPrices: PRICES });
  feed(t, JSON.stringify({ id: "resp_1", object: "response", model: "gpt-5", output: [], usage: { input_tokens: 2000, output_tokens: 300, input_tokens_details: { cached_tokens: 1000 }, output_tokens_details: { reasoning_tokens: 200 } } }));
  const r = t.finish({ aborted: false, status: 200 });
  close(r.usd, (1000 * 1.25 + 1000 * 0.125 + 300 * 10) / 1e6);
});

test("openai responses SSE: response.completed carries the usage", () => {
  const body = sse([
    ["response.created", { type: "response.created", response: { id: "resp_1", model: "gpt-5", usage: null } }],
    ["response.output_text.delta", { type: "response.output_text.delta", delta: "Hi there" }],
    ["response.completed", { type: "response.completed", response: { id: "resp_1", model: "gpt-5", usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0 } } } }],
  ]);
  const t = new UsageTracker("openai", "text/event-stream", { codexPrices: PRICES });
  feed(t, body, 4);
  const r = t.finish({ aborted: false, status: 200 });
  assert.equal(r.estimated, false);
  assert.equal(r.model, "gpt-5");
  close(r.usd, (100 * 1.25 + 20 * 10) / 1e6);
});

test("openai responses SSE aborted before completion is estimated", () => {
  const body = sse([
    ["response.created", { type: "response.created", response: { model: "gpt-5" } }],
    ["response.output_text.delta", { type: "response.output_text.delta", delta: "abcdefghijkl" }],
  ]);
  const t = new UsageTracker("openai", "text/event-stream", { codexPrices: PRICES });
  feed(t, body);
  const r = t.finish({ aborted: true, status: 200 });
  assert.equal(r.estimated, true);
  close(r.usd, (3 * 10) / 1e6);
});

// --- Relay mode (request estimate and worst case known) ------------------------------------

const relay = (format: "anthropic" | "openai", ct: string) =>
  new UsageTracker(format, ct, { requestModel: format === "anthropic" ? "claude-sonnet-4-6" : "gpt-5", codexPrices: PRICES, requestInputTokens: 2000, worstCaseUsd: 0.5 });

test("relay mode: final usage is still charged exactly", () => {
  const t = relay("anthropic", "text/event-stream");
  feed(t, anthropicStream(true));
  const r = t.finish({ aborted: false, status: 200 });
  assert.equal(r.estimated, false);
  close(r.usd, (2000 * 1 + 1000 * 0.1 + 40 * 5) / 1e6);
});

test("relay mode: a stream cut before message_start is charged the request's estimated input", () => {
  const t = relay("anthropic", "text/event-stream");
  feed(t, sse([["ping", { type: "ping" }]]));
  const r = t.finish({ aborted: true, status: 200 });
  assert.equal(r.estimated, true);
  close(r.usd, (2000 * 3) / 1e6);
});

test("relay mode: a chat stream without usage is charged estimated input plus streamed output", () => {
  const t = relay("openai", "text/event-stream");
  feed(t, sse([[null, { object: "chat.completion.chunk", model: "gpt-5", choices: [{ delta: { content: "12345678" } }] }], [null, "[DONE]"]]));
  const r = t.finish({ aborted: false, status: 200 });
  assert.equal(r.estimated, true);
  close(r.usd, (2000 * 1.25 + 2 * 10) / 1e6);
});

test("relay mode: a non-streamed success without usage (or any body type the meter can't read) costs the worst case", () => {
  for (const ct of ["application/json", "audio/mpeg", "text/plain"]) {
    const t = relay("anthropic", ct);
    feed(t, ct.includes("json") ? JSON.stringify({ id: "batch_1", type: "message_batch" }) : "binary");
    const r = t.finish({ aborted: false, status: 200 });
    assert.deepEqual([r.usd, r.estimated], [0.5, true], ct);
  }
  const cut = relay("anthropic", "application/json");
  feed(cut, '{"type":"message","content":[');
  assert.equal(cut.finish({ aborted: true, status: 200 }).usd, 0.5);
});

test("relay mode: provider errors cost nothing", () => {
  const err = relay("anthropic", "application/json");
  feed(err, JSON.stringify({ type: "error", error: { type: "overloaded_error" } }));
  assert.equal(err.finish({ aborted: false, status: 529 }).usd, 0);
  const sseErr = relay("anthropic", "text/event-stream");
  feed(sseErr, sse([["error", { type: "error", error: { type: "overloaded_error" } }]]));
  assert.equal(sseErr.finish({ aborted: false, status: 200 }).usd, 0);
});
