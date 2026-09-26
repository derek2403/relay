// GET /install.sh : the CLI installer (lib/relay/install-script.ts).
//
//   curl -fsSL <relay>/install.sh | sh
//
// It installs the bundle this relay serves at /cli/relay.mjs (npm run build:cli, which npm run dev
// and npm run build run first) as the `relay` command, pointed at this relay: RELAY_PUBLIC_URL's
// origin when set (and not a loopback address asked for from elsewhere), else the host and protocol
// this request was made to (Host / X-Forwarded-*).

import { installOrigin, installScript, requestOrigin } from "@/lib/relay/install-script";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const requestUrl = requestOrigin({
    url: request.url,
    host: request.headers.get("host"),
    forwardedHost: request.headers.get("x-forwarded-host"),
    forwardedProto: request.headers.get("x-forwarded-proto"),
  });
  const relayUrl = installOrigin({ publicUrl: process.env.RELAY_PUBLIC_URL, requestUrl });
  return new Response(installScript({ relayUrl }), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
