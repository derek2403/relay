// GET /pat?name=<ens name>[&hours=N] : a script that makes a PAT for that name on the caller's
// machine with the installed relay CLI (lib/relay/pat-script.ts):
//
//   curl -fsSL "<relay>/pat?name=derek.cloudops.dev.sodalabs.eth" | sh >> .env
//
// The relay only serves the script; the token is signed locally by the key that owns the name.
// A missing or invalid name or hours answers 400 with a script that prints the error.

import { parsePatQuery, patErrorScript, patScript, scriptOrigin } from "@/lib/relay/pat-script";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export function GET(request: Request) {
  const query = parsePatQuery(new URL(request.url).searchParams);
  if (!query.ok) return new Response(patErrorScript(query.error), { status: 400, headers: HEADERS });
  return new Response(patScript({ relayUrl: scriptOrigin(request), name: query.name, hours: query.hours }), { headers: HEADERS });
}
