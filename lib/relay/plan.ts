// What a metered call may cost, worked out before it is sent.
//
// The relay reserves a call's worst case (estimated input + its output-token
// limit, at the model's price) against every capped level before forwarding,
// and settles to the real cost when the call ends. Every generation call
// therefore needs an output limit the provider enforces:
// - a limit the client set is kept; the call is refused if its worst case
//   doesn't fit the budget left
// - with no limit (OpenAI allows that) the relay sets one: the smaller of
//   RELAY_MAX_OUTPUT_TOKENS and what half the budget left can pay for, so a
//   call sent at the same time still fits (Codex sends two per turn)
// OpenAI Chat Completions streams also get stream_options.include_usage, so
// the final chunk reports usage (input tokens are otherwise never reported).
//
// Image calls are planned by count: the request's `n` (default 1) is reserved
// against every count cap (relay.max.openai-images) and priced per image.

import type { ProviderId } from "./bundle";
import type { CodexPrices } from "./config";
import { claudePrice, codexPrice, estimateInputTokens } from "./pricing";
import type { RouteApi, RouteKind } from "./routes";

/** Below this many affordable output tokens the relay refuses instead of setting a tiny limit. */
export const MIN_OUTPUT_TOKENS = 256;

export type CallPlan = {
  kind: RouteKind;
  model: string | null;
  streaming: boolean;
  /** Estimated input tokens (high on purpose). */
  inputTokens: number;
  /** Output-token limit the provider will enforce (times `n` choices). */
  outputTokens: number;
  /** Cost of the estimated input alone. */
  floorUsd: number;
  /** Most the call can cost: estimated input plus the output limit. */
  worstUsd: number;
  /** Body to send upstream (rewritten when the relay set a limit or asked for usage). */
  body: Uint8Array | null;
  /** Set when the relay chose the output limit. */
  injectedLimit: number | null;
};

export type PlanResult = { ok: true; plan: CallPlan } | { ok: false; status: number; error: string; reason: string };

type Json = Record<string, unknown>;

const posInt = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null);

/** $ per token for input and output, including multipliers the request asks for (cache writes, fast mode). */
function perToken(provider: ProviderId, model: string | null, json: Json | null, raw: string, codexPrices: CodexPrices) {
  if (provider === "claude") {
    const { price } = claudePrice(model);
    // Cache writes cost 1.25x input (5 min) or 2x (1 h); fast mode doubles everything.
    const cacheWrite = /"ttl"\s*:\s*"1h"/.test(raw) ? 2 : raw.includes('"cache_control"') ? 1.25 : 1;
    const speed = json?.speed === "fast" ? 2 : 1;
    return { input: (price.input * cacheWrite * speed) / 1e6, output: (price.output * speed) / 1e6 };
  }
  const [input, output] = codexPrice(model, codexPrices).price;
  return { input: input / 1e6, output: output / 1e6 };
}

/** Where each API keeps its output limit. */
function limitField(api: RouteApi | null, json: Json): { field: string | null; value: number | null } {
  if (api === "anthropic-messages") return { field: "max_tokens", value: posInt(json.max_tokens) };
  if (api === "openai-responses") return { field: "max_output_tokens", value: posInt(json.max_output_tokens) };
  if (api === "openai-chat") {
    const v = posInt(json.max_completion_tokens) ?? posInt(json.max_tokens);
    return { field: "max_completion_tokens", value: v };
  }
  return { field: null, value: null };
}

const usd = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;

/**
 * Plans one metered call. `available` is the smallest budget left across the
 * capped levels (null = uncapped), read just before reserving.
 */
export function planCall(opts: {
  provider: ProviderId;
  kind: RouteKind;
  api: RouteApi | null;
  body: Uint8Array | null;
  available: number | null;
  maxOutputTokens: number;
  codexPrices: CodexPrices;
}): PlanResult {
  const { provider, kind, api, body, available } = opts;
  const bytes = body?.byteLength ?? 0;
  const raw = body && bytes ? new TextDecoder().decode(body) : "";
  let json: Json | null = null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      json = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : null;
    } catch {
      json = null;
    }
  }
  const model = typeof json?.model === "string" ? json.model : null;
  const streaming = json?.stream === true;
  const empty: CallPlan = { kind, model, streaming, inputTokens: 0, outputTokens: 0, floorUsd: 0, worstUsd: 0, body, injectedLimit: null };
  if (kind === "free") return { ok: true, plan: empty };
  // Operator-added routes may have no body; the known APIs always send a JSON object.
  if (!json && api === "custom" && !raw) json = {};
  if (!json) return { ok: false, status: 400, error: "bad request", reason: "Metered requests must have a JSON object body." };

  const price = perToken(provider, model, json, raw, opts.codexPrices);
  const inputTokens = estimateInputTokens(json, bytes);
  const floorUsd = inputTokens * price.input;
  if (kind === "embed") return { ok: true, plan: { ...empty, inputTokens, floorUsd, worstUsd: floorUsd } };

  const n = api === "openai-chat" ? (posInt(json.n) ?? 1) : 1;
  const { field, value } = limitField(api, json);
  let limit = value ?? opts.maxOutputTokens;
  let injectedLimit: number | null = null;
  let out = json;

  if (value === null && field && api !== "anthropic-messages") {
    // No limit set: pick one the budget can pay for. (Anthropic requires max_tokens, so a request
    // without it fails upstream and is only reserved at the default.)
    const affordable = available === null ? Infinity : Math.floor((available - floorUsd) / (price.output * n));
    // Written so NaN (free output with exactly the input's cost left) is refused, never reserved.
    if (!(affordable >= MIN_OUTPUT_TOKENS)) {
      return {
        ok: false,
        status: 403,
        error: "denied",
        reason: `not enough budget left for this call: ${usd(Math.max(0, available ?? 0))} left, but its input and ${MIN_OUTPUT_TOKENS * n} output tokens could cost ${usd(floorUsd + MIN_OUTPUT_TOKENS * n * price.output)}`,
      };
    }
    // Half of it, not all: a call sent at the same time (Codex sends a turn and a title request
    // together) must still fit. A share f leaves the later of two calls f·(1−f) of the output budget
    // in either order, most at ½. The only floor is MIN_OUTPUT_TOKENS, so refusals start where they
    // did (a bigger one would let one call take all of a small budget again). The limit still fits
    // what's left, so no cap can be exceeded.
    limit = Math.min(opts.maxOutputTokens, Math.max(MIN_OUTPUT_TOKENS, Math.floor(affordable / 2)));
    injectedLimit = limit;
    out = { ...out, [field]: limit };
  }
  if (api === "openai-chat" && streaming) {
    const so = out.stream_options && typeof out.stream_options === "object" ? (out.stream_options as Json) : {};
    if (so.include_usage !== true) out = { ...out, stream_options: { ...so, include_usage: true } };
  }

  const outputTokens = limit * n;
  const worstUsd = floorUsd + outputTokens * price.output;
  if (available !== null && worstUsd > available) {
    return {
      ok: false,
      status: 403,
      error: "denied",
      reason: `this call could cost up to ${usd(worstUsd)} (${outputTokens} output tokens at most), but only ${usd(Math.max(0, available))} is left; lower ${field ?? "the output limit"} or raise the cap`,
    };
  }
  const rewritten = out === json ? body : new TextEncoder().encode(JSON.stringify(out));
  return { ok: true, plan: { kind, model, streaming, inputTokens, outputTokens, floorUsd, worstUsd, body: rewritten, injectedLimit } };
}

/** Most images one OpenAI request can ask for. */
export const MAX_IMAGES_PER_REQUEST = 10;

export type ImagePlan = { ok: true; n: number; streaming: boolean } | { ok: false; status: number; error: string; reason: string };

/**
 * Reads how many images an OpenAI image request asks for: `n` in a JSON body
 * (generations) or a multipart form (edits), default 1. Refuses bodies it
 * can't read, so a hidden `n` can never get past the count limit.
 */
export async function planImages(body: Uint8Array | null, contentType: string | null): Promise<ImagePlan> {
  const bad = (reason: string): ImagePlan => ({ ok: false, status: 400, error: "bad request", reason });
  const ct = (contentType ?? "").toLowerCase();
  let rawN: unknown;
  let streaming = false;
  if (ct.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await new Response(body as Uint8Array<ArrayBuffer> | null, { headers: { "content-type": contentType! } }).formData();
    } catch {
      return bad("The relay couldn't read this multipart image request.");
    }
    if (form.getAll("n").length > 1) return bad("Send n once.");
    rawN = form.get("n") ?? undefined;
    streaming = form.get("stream") === "true";
  } else {
    let json: unknown;
    try {
      json = body && body.byteLength ? JSON.parse(new TextDecoder().decode(body)) : null;
    } catch {
      json = null;
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) return bad("Image requests must have a JSON object or multipart/form-data body.");
    rawN = (json as Record<string, unknown>).n;
    streaming = (json as Record<string, unknown>).stream === true;
  }
  if (rawN === undefined || rawN === null || rawN === "") return { ok: true, n: 1, streaming };
  const n = typeof rawN === "number" ? rawN : typeof rawN === "string" && /^\d+$/.test(rawN.trim()) ? Number(rawN.trim()) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGES_PER_REQUEST) return bad(`n must be a whole number from 1 to ${MAX_IMAGES_PER_REQUEST}.`);
  return { ok: true, n, streaming };
}
