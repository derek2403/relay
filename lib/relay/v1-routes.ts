// OpenAI-style relay URLs: <relay>/v1/<api>/<path> (app/v1/[provider]/[[...path]]/route.ts).
//
// Point an SDK's base URL at <relay>/v1/openai (the OpenAI SDK: chat.completions, responses,
// embeddings, models, images.generate), <relay>/v1/anthropic (the Anthropic SDK) or call
// <relay>/v1/weather/forecast?... (Open-Meteo), and pass a Keyless Relay token (kr1...) where the
// API key goes. Each URL is mapped onto the relay's own route, /api/relay/<provider>/<upstream path>,
// and handled by handleRelayRequest unchanged: the same token check, ENS policy, route rules,
// metering, streaming, live revocation and log.
//
//   /v1/openai/images/<rest>  -> openai-images  /v1/images/<rest>
//   /v1/openai/<rest>         -> codex          /v1/<rest>
//   /v1/anthropic/<rest>      -> claude         /v1/<rest>
//   /v1/weather/<rest>        -> weather        /v1/<rest>
//   /v1/<catalog id>/<rest>   -> that provider  /<rest>
//
// After an alias (openai, anthropic, weather) one leading "v1" is dropped, so a base URL with or
// without its own /v1 works: the Anthropic SDK given <relay>/v1/anthropic calls
// /v1/anthropic/v1/messages, which is claude's /v1/messages (no provider has a /v1/v1 path).

import { type ProviderId, PROVIDER_IDS, isProviderId } from "./catalog";
import { type RelayDeps, handleRelayRequest } from "./providers";

/** Base URL names that aren't catalog ids (weather is both: the alias wins, adding /v1). */
const ALIASES = new Map<string, ProviderId>([
  ["openai", "codex"],
  ["anthropic", "claude"],
  ["weather", "weather"],
]);

export type V1Route = {
  provider: ProviderId;
  /** The upstream path, still percent-encoded ("" for the provider's base). */
  path: string;
  /** The query string, unchanged ("" or "?..."). */
  search: string;
};

const under = (prefix: string, rest: readonly string[]) => (rest.length ? `${prefix}/${rest.join("/")}` : prefix);

/**
 * The provider and upstream path for the raw (percent-encoded) path segments after /v1, or null
 * when the first segment is neither an alias nor a catalog id. Segments pass through as they are;
 * the relay validates the path (buildUpstreamUrl) after it has checked the token.
 */
export function mapV1Path(segments: readonly string[], search = ""): V1Route | null {
  const [head, ...rest] = segments;
  if (!head) return null;
  const alias = ALIASES.get(head);
  if (alias) {
    const tail = rest[0] === "v1" ? rest.slice(1) : rest;
    if (head === "openai" && tail[0] === "images") return { provider: "openai-images", path: under("/v1", tail), search };
    return { provider: alias, path: under("/v1", tail), search };
  }
  if (isProviderId(head)) return { provider: head, path: rest.length ? `/${rest.join("/")}` : "", search };
  return null;
}

/** The raw path segments after /v1/ in a URL's (still encoded) pathname, or null for other paths. */
export function v1Segments(pathname: string): string[] | null {
  return pathname.startsWith("/v1/") ? pathname.slice("/v1/".length).split("/") : null;
}

/**
 * The /api/relay URL a mapped route is served at, on `origin`. Null when URL parsing would change
 * the path (a "." or ".." segment, also percent-encoded, which the URL parser resolves): the
 * relay must see exactly the path that was mapped.
 */
export function v1RelayUrl(origin: string, route: V1Route): string | null {
  const pathname = `/api/relay/${route.provider}${route.path}`;
  let url: URL;
  try {
    url = new URL(`${pathname}${route.search}`, origin);
  } catch {
    return null;
  }
  return url.pathname === pathname ? url.href : null;
}

export const V1_USAGE = `Use /v1/openai (OpenAI text and images), /v1/anthropic, /v1/weather, or /v1/<provider>/<path> for one of: ${PROVIDER_IDS.join(", ")}.`;

const errorJson = (status: number, error: string, reason: string) =>
  Response.json({ error, reason }, { status, headers: { "cache-control": "no-store" } });

/**
 * Handles /v1/<api>/<path>: maps it (mapV1Path) and hands the relay a request for the mapped
 * /api/relay URL with the same method, headers, body stream and abort signal. 404 for an unknown
 * API, 400 for a path with dot segments; everything else is the relay's answer.
 */
export async function handleV1Request(request: Request, deps: RelayDeps): Promise<Response> {
  const url = new URL(request.url);
  const segments = v1Segments(url.pathname);
  const route = segments ? mapV1Path(segments, url.search) : null;
  if (!route) {
    deps.meter.countRejected();
    const head = (segments?.[0] ?? "").slice(0, 64);
    return errorJson(404, "unknown provider", `${head ? `"${head}" is not an API this relay serves. ` : ""}${V1_USAGE}`);
  }
  const target = v1RelayUrl(url.origin, route);
  if (!target) {
    deps.meter.countRejected();
    return errorJson(400, "bad path", "dot segments are not allowed");
  }
  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? null : request.body;
  // duplex: "half" is required to send a stream as a request body (Node's fetch); not yet in lib.dom's RequestInit.
  const init: RequestInit & { duplex?: "half" } = { method: request.method, headers: request.headers, signal: request.signal };
  if (body) {
    init.body = body;
    init.duplex = "half";
  }
  return handleRelayRequest(new Request(target, init), route.provider, deps);
}
