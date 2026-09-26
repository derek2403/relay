// OpenAI-style relay URLs: /v1/<api>/<path> (lib/relay/v1-routes.ts). Point an SDK here, e.g.
// OPENAI_BASE_URL=https://relay.example/v1/openai with OPENAI_API_KEY=kr1..., and it gets the same
// checks, limits and metering as /api/relay/<provider>/<path>:
//
//   /v1/openai/images/...  -> openai-images   /v1/images/...
//   /v1/openai/...         -> codex           /v1/...
//   /v1/anthropic/...      -> claude          /v1/...
//   /v1/weather/...        -> weather         /v1/... (Open-Meteo)
//   /v1/<provider>/...     -> that provider   /...

import { relayDeps } from "@/lib/relay/policy";
import { handleV1Request } from "@/lib/relay/v1-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The path is read from request.url (still percent-encoded), not from params (decoded).
function handle(request: Request) {
  return handleV1Request(request, relayDeps());
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
