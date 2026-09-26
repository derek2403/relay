// Token usage -> dollars, for Anthropic Messages and OpenAI (Chat Completions
// and Responses) bodies, both JSON and server-sent events.
//
// UsageTracker sees every response chunk as it streams past and works out
// the cost when the body ends. If the stream is cut short, or no usage ever
// arrives, it estimates: the input usage it saw (or, in relay mode, the input
// estimated from the request) plus ~chars/4 output tokens of the text it
// streamed, and marks the result estimated. In relay mode a non-streamed
// response without usage is charged the call's worst case.

import type { CodexPrices } from "./config";

// --- Prices -----------------------------------------------------------------

export type ClaudePrice = { input: number; output: number; cacheRead?: number };

/** $ per million tokens, from the claude-api skill (cached 2026-06-24). */
export const CLAUDE_PRICES: Record<string, ClaudePrice> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** Unknown Claude models are charged at the most expensive rate (conservative). */
export const UNKNOWN_CLAUDE_PRICE: ClaudePrice = { input: 10, output: 50, cacheRead: 1 };

/**
 * ESTIMATED OpenAI prices in $ per million tokens: [input, output, cached input].
 * Not an official price list: good enough for a demo's budgets to move. Set
 * RELAY_CODEX_PRICES for real ones (it always wins). Matched exactly, then by
 * the longest prefix ("gpt-5" covers "gpt-5.1-codex").
 */
export const CODEX_ESTIMATED_PRICES: Record<string, [number, number, number]> = {
  "gpt-5": [1.25, 10, 0.125],
  "gpt-5-codex": [1.25, 10, 0.125],
  "gpt-5-mini": [0.25, 2, 0.025],
  "gpt-5.1-codex-mini": [0.25, 2, 0.025],
  "gpt-5-nano": [0.05, 0.4, 0.005],
  "gpt-5-pro": [15, 120, 15],
  "codex-mini": [1.5, 6, 0.375],
  "gpt-4.1": [2, 8, 0.5],
  "gpt-4.1-mini": [0.4, 1.6, 0.1],
  "gpt-4.1-nano": [0.1, 0.4, 0.025],
  "gpt-4o": [2.5, 10, 1.25],
  "gpt-4o-mini": [0.15, 0.6, 0.075],
  o3: [2, 8, 0.5],
  "o3-pro": [20, 80, 20],
  "o4-mini": [1.1, 4.4, 0.275],
  "text-embedding-3-small": [0.02, 0, 0.02],
  "text-embedding-3-large": [0.13, 0, 0.13],
};

/** PLACEHOLDER OpenAI price for models in neither RELAY_CODEX_PRICES nor the estimates. Not a real price. */
export const CODEX_PLACEHOLDER_PRICE: [number, number] = [5, 20];

const CLAUDE_KEYS_LONGEST_FIRST = Object.keys(CLAUDE_PRICES).sort((a, b) => b.length - a.length);

/** Matches exact ids and dated or aliased forms ("claude-haiku-4-5-20251001", "claude-opus-5@...", "claude-sonnet-4-6[1m]"). */
function matchModel(model: string, keys: string[]): string | null {
  const m = model.toLowerCase().replace(/^anthropic\./, "").replace(/\[[^\]]*\]$/, "");
  for (const key of keys) {
    if (m === key) return key;
    if (m.startsWith(`${key}@`)) return key;
    const rest = m.startsWith(`${key}-`) ? m.slice(key.length + 1) : null;
    if (rest !== null && /^(\d{8}|latest)$/.test(rest)) return key;
  }
  return null;
}

export function claudePrice(model: string | null): { price: ClaudePrice; known: boolean } {
  const key = model ? matchModel(model, CLAUDE_KEYS_LONGEST_FIRST) : null;
  return key ? { price: CLAUDE_PRICES[key], known: true } : { price: UNKNOWN_CLAUDE_PRICE, known: false };
}

const ESTIMATE_KEYS_LONGEST_FIRST = Object.keys(CODEX_ESTIMATED_PRICES).sort((a, b) => b.length - a.length);

/**
 * The price of an OpenAI model: RELAY_CODEX_PRICES (exact, longest prefix, "*"),
 * else the built-in estimate, else the placeholder. `known` = configured by the operator.
 */
export function codexPrice(
  model: string | null,
  prices: CodexPrices,
): { price: [number, number, number]; known: boolean; source: "configured" | "estimate" | "placeholder" } {
  const table = Object.keys(prices).sort((a, b) => b.length - a.length);
  const m = (model ?? "").toLowerCase();
  // Exact match, then the longest configured prefix ("gpt-5" covers "gpt-5-2026-01-01"), then "*".
  const key = table.find((k) => k === m) ?? table.find((k) => k !== "*" && m.startsWith(k)) ?? (prices["*"] ? "*" : null);
  if (key) {
    const p = prices[key];
    // Cached input defaults to the full input price: conservative when the real discount is unknown.
    return { price: [p[0], p[1], p[2] ?? p[0]], known: true, source: "configured" };
  }
  const estimate = m ? (ESTIMATE_KEYS_LONGEST_FIRST.find((k) => k === m) ?? ESTIMATE_KEYS_LONGEST_FIRST.find((k) => m.startsWith(k))) : undefined;
  if (estimate) return { price: CODEX_ESTIMATED_PRICES[estimate], known: false, source: "estimate" };
  const p = CODEX_PLACEHOLDER_PRICE;
  return { price: [p[0], p[1], p[0]], known: false, source: "placeholder" };
}

// --- Usage shapes -----------------------------------------------------------

export type AnthropicUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
  speed?: string | null;
};

/** Normalized OpenAI usage. `cached` is a subset of `input` (OpenAI counts cached tokens inside prompt/input tokens). */
export type OpenAIUsage = { input: number; output: number; cached: number };

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

export function claudeCostUsd(model: string | null, usage: AnthropicUsage): number {
  const { price } = claudePrice(model);
  const cacheRead = price.cacheRead ?? price.input * 0.1;
  const cc = usage.cache_creation;
  const has5m1h = !!cc && (cc.ephemeral_5m_input_tokens != null || cc.ephemeral_1h_input_tokens != null);
  const cacheWrite = has5m1h
    ? n(cc?.ephemeral_5m_input_tokens) * price.input * 1.25 + n(cc?.ephemeral_1h_input_tokens) * price.input * 2
    : n(usage.cache_creation_input_tokens) * price.input * 1.25;
  const total =
    n(usage.input_tokens) * price.input + cacheWrite + n(usage.cache_read_input_tokens) * cacheRead + n(usage.output_tokens) * price.output;
  return (total / 1e6) * (usage.speed === "fast" ? 2 : 1);
}

export function codexCostUsd(model: string | null, usage: OpenAIUsage, prices: CodexPrices): number {
  const [input, output, cached] = codexPrice(model, prices).price;
  const cachedTokens = Math.min(n(usage.cached), n(usage.input));
  return ((n(usage.input) - cachedTokens) * input + cachedTokens * cached + n(usage.output) * output) / 1e6;
}

/** Pulls OpenAI usage from either API's shape; null when absent. */
export function openAIUsageFrom(raw: unknown): OpenAIUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const details = (key: string) => (u[key] && typeof u[key] === "object" ? (u[key] as Record<string, unknown>) : {});
  if ("prompt_tokens" in u || "completion_tokens" in u) {
    return { input: n(u.prompt_tokens), output: n(u.completion_tokens), cached: n(details("prompt_tokens_details").cached_tokens) };
  }
  if ("input_tokens" in u || "output_tokens" in u) {
    return { input: n(u.input_tokens), output: n(u.output_tokens), cached: n(details("input_tokens_details").cached_tokens) };
  }
  return null;
}

// --- Request estimates --------------------------------------------------------

/**
 * A deliberately high estimate of a request's input tokens, from its JSON
 * body: text at ~3 bytes per token (real text is closer to 4), base64 media
 * at ~40 characters per token (images are cheaper, PDFs about that). Media is
 * only recognized where the APIs carry it: Anthropic `{type: "base64", data}`
 * sources and `data:<type>;base64,` URLs (OpenAI images and files).
 * Used to reserve budget before a call and as the input charge when a call
 * ends without reporting usage.
 */
export function estimateInputTokens(json: unknown, byteLength: number): number {
  let media = 0;
  const walk = (v: unknown, depth: number) => {
    if (depth > 64) return;
    if (typeof v === "string") {
      if (v.startsWith("data:") && v.slice(0, 100).includes(";base64,")) media += v.length;
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
    } else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.type === "base64" && typeof o.data === "string") media += o.data.length;
      for (const [k, x] of Object.entries(o)) if (!(k === "data" && o.type === "base64")) walk(x, depth + 1);
    }
  };
  walk(json, 0);
  const text = Math.max(0, byteLength - media);
  return Math.ceil(text / 3) + Math.ceil(media / 40);
}

// --- Streaming tracker ------------------------------------------------------

export type UsageFormat = "anthropic" | "openai";

export type MeterResult = {
  usd: number;
  estimated: boolean;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
};

/** JSON bodies larger than this are not parsed for usage (the cost is estimated instead). */
const MAX_JSON_CHARS = 16 * 1024 * 1024;
const MAX_SSE_EVENT_CHARS = 4 * 1024 * 1024;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : null);

export class UsageTracker {
  private readonly decoder = new TextDecoder();
  private readonly mode: "sse" | "json" | "other";
  private json = "";
  private jsonOverflow = false;
  private sse = "";
  private totalChars = 0;
  private streamedChars = 0;

  private model: string | null;
  private anthropic: AnthropicUsage | null = null;
  private openai: OpenAIUsage | null = null;
  /** True once the final usage arrived (Anthropic message_delta, OpenAI usage chunk / response.completed, or a JSON body). */
  private final = false;
  /** The provider sent an error event/object. */
  private sawError = false;

  /**
   * `requestInputTokens` and `worstCaseUsd` switch on relay mode: a stream
   * without input usage is charged the request's estimated input, and a
   * non-streamed success without usage is charged `worstCaseUsd`.
   */
  constructor(
    private readonly format: UsageFormat,
    contentType: string | null,
    private readonly opts: { requestModel?: string | null; codexPrices?: CodexPrices; requestInputTokens?: number; worstCaseUsd?: number } = {},
  ) {
    const ct = (contentType ?? "").toLowerCase();
    this.mode = ct.includes("text/event-stream") ? "sse" : ct.includes("json") ? "json" : "other";
    this.model = opts.requestModel ?? null;
  }

  push(chunk: Uint8Array) {
    this.consume(this.decoder.decode(chunk, { stream: true }));
  }

  private consume(text: string) {
    if (!text) return;
    this.totalChars += text.length;
    if (this.mode === "json") {
      if (!this.jsonOverflow) {
        this.json += text;
        if (this.json.length > MAX_JSON_CHARS) {
          this.json = "";
          this.jsonOverflow = true;
        }
      }
    } else if (this.mode === "sse") {
      this.sse += text;
      this.drainSse(false);
    }
  }

  private drainSse(end: boolean) {
    // Normalize CRLF/CR line endings; hold a trailing "\r" in case its "\n" is in the next chunk.
    let buf = this.sse;
    const heldCr = !end && buf.endsWith("\r");
    if (heldCr) buf = buf.slice(0, -1);
    buf = buf.replace(/\r\n?/g, "\n");
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      this.handleSseEvent(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
    if (end && buf.trim()) {
      this.handleSseEvent(buf);
      buf = "";
    }
    // A runaway event with no terminator: drop it rather than grow without bound.
    if (buf.length > MAX_SSE_EVENT_CHARS) buf = "";
    this.sse = heldCr ? `${buf}\r` : buf;
  }

  private handleSseEvent(block: string) {
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
    }
    const payload = data.join("\n").trim();
    if (!payload || payload === "[DONE]") return;
    let obj: unknown;
    try {
      obj = JSON.parse(payload);
    } catch {
      return;
    }
    if (isObj(obj)) this.handleObject(obj);
  }

  private handleObject(obj: Obj) {
    if (obj.type === "error" || isObj(obj.error)) this.sawError = true;
    if (this.format === "anthropic") this.handleAnthropic(obj);
    else this.handleOpenAI(obj);
  }

  private handleAnthropic(obj: Obj) {
    const type = str(obj.type);
    if (type === "message_start" && isObj(obj.message)) {
      this.model = str(obj.message.model) ?? this.model;
      if (isObj(obj.message.usage)) this.anthropic = { ...(obj.message.usage as AnthropicUsage) };
    } else if (type === "message_delta" && isObj(obj.usage)) {
      // output_tokens is cumulative (keep the last); newer APIs may repeat input counts here too.
      const merged: AnthropicUsage = { ...(this.anthropic ?? {}) };
      for (const [k, v] of Object.entries(obj.usage)) if (v !== null && v !== undefined) (merged as Obj)[k] = v;
      this.anthropic = merged;
      this.final = true;
    } else if (type === "content_block_delta" && isObj(obj.delta)) {
      const d = obj.delta;
      this.streamedChars += (str(d.text) ?? str(d.thinking) ?? str(d.partial_json) ?? "").length;
    } else if (type === "message" && isObj(obj.usage)) {
      this.model = str(obj.model) ?? this.model;
      this.anthropic = { ...(obj.usage as AnthropicUsage) };
      this.final = true;
    }
  }

  private handleOpenAI(obj: Obj) {
    const type = str(obj.type);
    // Responses API streaming events.
    if (type?.startsWith("response.")) {
      const response = isObj(obj.response) ? obj.response : null;
      if (response) this.model = str(response.model) ?? this.model;
      if (type.endsWith(".delta")) this.streamedChars += (str(obj.delta) ?? "").length;
      if (response && (type === "response.completed" || type === "response.incomplete" || type === "response.failed")) {
        const usage = openAIUsageFrom(response.usage);
        if (usage) {
          this.openai = usage;
          this.final = true;
        }
      }
      return;
    }
    // Chat Completions chunks and JSON bodies of either API.
    this.model = str(obj.model) ?? this.model;
    if (Array.isArray(obj.choices)) {
      for (const choice of obj.choices) {
        if (!isObj(choice) || !isObj(choice.delta)) continue;
        const d = choice.delta;
        this.streamedChars += (str(d.content) ?? "").length + (str(d.reasoning_content) ?? "").length + (str(d.refusal) ?? "").length;
        if (Array.isArray(d.tool_calls)) {
          for (const call of d.tool_calls) {
            if (isObj(call) && isObj(call.function)) this.streamedChars += (str(call.function.arguments) ?? "").length;
          }
        }
      }
    }
    const usage = openAIUsageFrom(obj.usage);
    if (usage) {
      this.openai = usage;
      this.final = true;
    }
  }

  /**
   * Cost of the response. `aborted` means the body didn't finish (client left
   * or upstream failed).
   *
   * Without final usage: a stream is estimated from the input usage it saw
   * plus the text it streamed; a complete JSON body with no usage (model
   * lists, token counts, errors) costs nothing; a cut-off JSON body of a
   * generation request is estimated from the bytes that arrived.
   */
  finish({ aborted, status }: { aborted: boolean; status: number }): MeterResult {
    const tail = this.decoder.decode();
    if (tail) this.consume(tail);
    if (this.mode === "sse") this.drainSse(true);
    if (this.mode === "json" && !this.jsonOverflow && this.json.trim()) {
      try {
        const obj = JSON.parse(this.json);
        if (isObj(obj)) this.handleObject(obj);
      } catch {
        // Truncated or not JSON: fall through to the estimate.
      }
    }

    if (this.final) return this.result(false);

    const sawInput = !!(this.anthropic || this.openai);
    if (this.opts.worstCaseUsd !== undefined) return this.relayEstimate(aborted, status, sawInput);
    const chars =
      this.mode === "sse" ? this.streamedChars : (aborted || this.jsonOverflow) && this.model ? this.totalChars : 0;
    if (!sawInput && (chars === 0 || (!aborted && status >= 400))) {
      return { usd: 0, estimated: false, model: this.model, inputTokens: 0, outputTokens: 0 };
    }

    // Estimate: input usage if seen, plus ~chars/4 output tokens of what streamed.
    const estOutput = Math.ceil(chars / 4);
    if (this.format === "anthropic") {
      const base = this.anthropic ?? {};
      this.anthropic = { ...base, output_tokens: Math.max(n(base.output_tokens), estOutput) };
    } else {
      const base = this.openai ?? { input: 0, output: 0, cached: 0 };
      this.openai = { ...base, output: Math.max(base.output, estOutput) };
    }
    return this.result(true);
  }

  /**
   * Relay mode, no final usage:
   * - a non-2xx response, or an error event before any usage: $0 (providers don't bill errors or redirects)
   * - a stream: input usage seen, else the request's estimated input, plus ~chars/4 of streamed output
   * - anything else (a non-streamed body without usage, cut off or not): the call's worst case
   */
  private relayEstimate(aborted: boolean, status: number, sawInput: boolean): MeterResult {
    const none = { usd: 0, estimated: false, model: this.model, inputTokens: 0, outputTokens: 0 };
    if (status < 200 || status >= 300) return none;
    if (this.sawError && !sawInput && !aborted) return none;
    if (this.mode !== "sse") {
      return { usd: this.opts.worstCaseUsd ?? 0, estimated: true, model: this.model, inputTokens: this.opts.requestInputTokens ?? 0, outputTokens: 0 };
    }
    const estInput = this.opts.requestInputTokens ?? 0;
    const estOutput = Math.ceil(this.streamedChars / 4);
    if (this.format === "anthropic") {
      const base = this.anthropic ?? { input_tokens: estInput };
      this.anthropic = { ...base, output_tokens: Math.max(n(base.output_tokens), estOutput) };
    } else {
      const base = this.openai && this.openai.input > 0 ? this.openai : { input: estInput, output: this.openai?.output ?? 0, cached: 0 };
      this.openai = { ...base, output: Math.max(base.output, estOutput) };
    }
    return this.result(true);
  }

  private result(estimated: boolean): MeterResult {
    if (this.format === "anthropic") {
      const u = this.anthropic ?? {};
      const input = n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
      return { usd: claudeCostUsd(this.model, u), estimated, model: this.model, inputTokens: input, outputTokens: n(u.output_tokens) };
    }
    const u = this.openai ?? { input: 0, output: 0, cached: 0 };
    return { usd: codexCostUsd(this.model, u, this.opts.codexPrices ?? {}), estimated, model: this.model, inputTokens: u.input, outputTokens: u.output };
  }
}
