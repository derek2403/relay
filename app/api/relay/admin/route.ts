// /api/relay/admin : sign in as the relay admin with RELAY_ADMIN_TOKEN.
// GET shows a small form; POST checks the token and sets an HttpOnly session
// cookie (an HMAC of the token, not the token), which the admin app's
// same-origin requests to /api/relay/log and /api/relay/policy then carry.

import type { NextRequest } from "next/server";

import { ADMIN_COOKIE, isAdmin } from "@/lib/relay/auth";
import { getConfig } from "@/lib/relay/config";
import { clientKey, relayLimits } from "@/lib/relay/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WEEK = 7 * 24 * 3600;

function page(message: string, signedIn: boolean, status = 200, cookie?: string) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relay admin</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 28rem; margin: 3rem auto; padding: 0 1rem; color: #18181b; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #e4e4e7; background: #09090b; } input { background: #18181b; color: inherit; } }
  input, button { font: inherit; padding: .5rem .75rem; border-radius: .5rem; border: 1px solid #a1a1aa; }
  input { width: 100%; box-sizing: border-box; margin: .5rem 0 1rem; }
  button { cursor: pointer; }
  p.note { color: #71717a; font-size: 13px; }
</style></head><body>
<h1>Relay admin</h1>
<p>${message}</p>
${
  signedIn
    ? `<form method="post"><input type="hidden" name="action" value="signout"><button>Sign out</button></form>
<p><a href="/">Back to the app</a></p>`
    : `<form method="post"><label>Admin token<input name="token" type="password" autocomplete="current-password" required autofocus></label><button>Sign in</button></form>`
}
<p class="note">Signing in lets this browser read the decision log and spend for every name.</p>
</body></html>`;
  const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
  if (cookie) headers["set-cookie"] = cookie;
  return new Response(html, { status, headers });
}

const secure = (request: NextRequest) => request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";

const cookieHeader = (request: NextRequest, value: string, maxAge: number) =>
  `${ADMIN_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure(request) ? "; Secure" : ""}`;

export async function GET(request: NextRequest) {
  const config = getConfig();
  if (!config.admin.enabled) {
    return page(
      config.viewAuth === "open"
        ? "RELAY_ADMIN_TOKEN is not set, so anyone who can reach this relay can read its log (fine for local development). Set it before others can reach the relay."
        : "RELAY_ADMIN_TOKEN is not set, so nobody can sign in. Set it in the relay's environment and restart.",
      false,
    );
  }
  return isAdmin(request, { config }) ? page("You are signed in.", true) : page("Enter the relay's RELAY_ADMIN_TOKEN.", false);
}

export async function POST(request: NextRequest) {
  const config = getConfig();
  if (!config.admin.enabled) return page("RELAY_ADMIN_TOKEN is not set on this relay.", false, 404);
  let token = "";
  let action = "";
  try {
    const form = await request.formData();
    token = String(form.get("token") ?? "");
    action = String(form.get("action") ?? "");
  } catch {
    return page("Send the form from this page.", false, 400);
  }
  if (action === "signout") return page("Signed out.", false, 200, cookieHeader(request, "", 0));

  const limits = relayLimits();
  const client = clientKey(request.headers);
  if (!limits.failures.has(client)) return page("Too many wrong tokens. Wait a minute and try again.", false, 429);
  if (!config.admin.check(token)) {
    limits.failures.spend(client);
    return page("That is not the admin token.", false, 401);
  }
  return new Response(null, { status: 303, headers: { location: "/", "set-cookie": cookieHeader(request, config.admin.cookie()!, WEEK), "cache-control": "no-store" } });
}
