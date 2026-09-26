// Pure helpers for the live Agents view (no React): try-a-call requests, log matching,
// session state and usage lines. Ported from SRC app/_components/{TryCall,LiveView,Usage}.tsx.

import { type Address, isAddressEqual } from "viem";

import { providerMark } from "@/lib/provider-marks";
import { type LiveState, SAMPLE_REQUESTS, type SampleRequest, type StoredAgentKey, depthOf, formatDuration, isNever, parentOf, sampleRequest, usd } from "@/lib/relay/browser";
import { type ProviderId, catalogEntry, countUnit, isProviderId } from "@/lib/relay/catalog";
import type { LevelView, LogEntry } from "@/lib/relay/types";

/** "Try a call" tokens live ten minutes at most, and never past the session. */
export const TRY_TOKEN_TTL_SEC = 600;

/** The relay's own refusals carry { error: string }; upstream errors use objects. */
export const RELAY_ERROR_STATUSES = [400, 401, 403, 404, 413, 502, 503];


/** Icon key for <Icon/>: catalog ids mapped to the brand marks in lib/provider-marks. */
export const markFor = providerMark;

/** Keys made for names under another company root would only get "not under <root>". */
export const keysUnderRoot = (keys: StoredAgentKey[], root: string | null) =>
  keys.filter((k) => k.name && (!root || k.name === root || k.name.endsWith(`.${root}`)));

/** Expiry for a one-off test token: now + 10 min, capped at the session's end. */
export const tryTokenExpiry = (now: number, sessionExpiry: number | null, ttl = TRY_TOKEN_TTL_SEC) =>
  sessionExpiry !== null ? Math.min(now + ttl, sessionExpiry) : now + ttl;

/**
 * Starting requests for APIs lib/relay/browser has no sample for yet (its SAMPLE_REQUESTS win).
 * Weather is OpenWeatherMap's read-only current weather for Tokyo; the relay adds its key (?appid=).
 */
export const EXTRA_SAMPLES: Readonly<Record<string, SampleRequest>> = {
  weather: {
    method: "GET",
    path: "/data/2.5/weather?q=Tokyo&units=metric",
    body: null,
    auth: "bearer",
  },
};

/** The request "Try a call" starts from for a provider. */
export const trySample = (provider: string): SampleRequest => SAMPLE_REQUESTS[provider] ?? EXTRA_SAMPLES[provider] ?? sampleRequest(provider);

/** Methods "Try a call" offers: read-only APIs (the relay forwards only GET for them) get GET alone. */
export const tryMethods = (provider: string): string[] => (provider === "weather" ? ["GET"] : ["GET", "POST"]);

export const sendsBody = (method: string, body: string) => method !== "GET" && method !== "HEAD" && body.trim() !== "";

/** x-api-key for Anthropic-style APIs (claude, mock), a Bearer header otherwise (SRC SAMPLE_REQUESTS.auth). */
export function requestHeaders(auth: SampleRequest["auth"], token: string, withBody: boolean): Record<string, string> {
  const headers: Record<string, string> = auth === "x-api-key" ? { "x-api-key": token } : { authorization: `Bearer ${token}` };
  if (withBody) headers["content-type"] = "application/json";
  return headers;
}

export const relayUrl = (provider: string, path: string) => `/api/relay/${provider}${path.startsWith("/") ? "" : "/"}${path}`;

export type CallResult = { status: number; denied: boolean; reason: string | null; body: string; sentAt: number };

/** Refused by the relay itself (its JSON { error }) vs anything the upstream answered. */
export function classifyResponse(status: number, text: string, sentAt: number): CallResult {
  let json: { error?: unknown; reason?: unknown } | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    json = parsed && typeof parsed === "object" ? (parsed as { error?: unknown; reason?: unknown }) : null;
    if (!json) return { status, denied: false, reason: null, body: JSON.stringify(parsed, null, 2), sentAt };
  } catch {
    // Not JSON (e.g. a stream or an HTML error page).
  }
  const denied = RELAY_ERROR_STATUSES.includes(status) && typeof json?.error === "string";
  return {
    status,
    denied,
    reason: denied ? String(json?.reason ?? json?.error) : null,
    body: json ? JSON.stringify(json, null, 2) : text,
    sentAt,
  };
}

const sameAddress = (a: string | null | undefined, b: string | null | undefined) => {
  if (!a || !b) return false;
  try {
    return isAddressEqual(a as Address, b as Address);
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
};

/** The log entry for a call sent at `sentAt` (2 s of clock slack), by name or by signer. */
export function matchLogEntry(
  entries: readonly LogEntry[] | undefined,
  call: { sentAt: number; provider: string; name: string | undefined; address: string },
): LogEntry | undefined {
  return entries?.find(
    (e) => e.ts >= call.sentAt - 2000 && e.provider === call.provider && ((!!call.name && e.name === call.name) || sameAddress(e.signer, call.address)),
  );
}

/** What the relay says about a name right now: its leaf level, live (every level registered), expiry, ended. */
export function sessionCheck(levels: readonly Pick<LevelView, "name" | "status" | "expiry">[], name: string | undefined, now: number) {
  const leaf = levels.find((l) => l.name === name);
  const live = !!leaf && levels.every((l) => l.status === "registered");
  const expiry = live ? leaf.expiry : null;
  const ended = !!leaf && (!live || (expiry !== null && expiry <= now));
  return { leaf, live, expiry, ended };
}

/** Countdown text for an agent key's session (expiry in unix seconds; now 0 = not mounted yet). */
export function sessionLabel(expiry: number | null | undefined, state: "live" | "ended" | "removed" | "unknown", now: number): string {
  if (state === "removed") return "removed";
  if (state === "ended") return "ended";
  if (state === "unknown" || expiry === undefined) return "not checked";
  if (expiry === null || isNever(expiry)) return "no expiry";
  if (!now) return "…";
  return expiry <= now ? "ended" : `ends in ${formatDuration(expiry - now)}`;
}

export type Outcome = { tone: "ok" | "refused"; text: string; loud: boolean };

/** The relay's own words: "killed: …" when it cut off a call in flight, "access revoked: …" when it refused one. */
export function logOutcome(e: Pick<LogEntry, "reason" | "allowed" | "status">): Outcome {
  const reason = e.reason ?? "";
  if (/^killed/i.test(reason)) return { tone: "refused", text: "killed", loud: true };
  if (/revoked/i.test(reason)) return { tone: "refused", text: "revoked", loud: true };
  return e.allowed ? { tone: "ok", text: `ok${e.status ? ` ${e.status}` : ""}`, loud: false } : { tone: "refused", text: "refused", loud: false };
}

/** "$0.012", "$0.01*" when estimated, "—" when unpriced. */
export const logCost = (e: Pick<LogEntry, "costUsd" | "estimated">) => (e.costUsd !== null ? `${usd(e.costUsd)}${e.estimated ? "*" : ""}` : "—");

/** Log entries from `user` and every name below it, since it was (re-)registered. */
export const decisionsFor = (log: readonly LogEntry[] | undefined, user: string, since: number, limit = 8) =>
  (log ?? []).filter((e) => e.ts >= since && e.name && (e.name === user || e.name.endsWith(`.${user}`))).slice(0, limit);

// --- Usage -----------------------------------------------------------------------------

export type UsageLine = { text: string; pct: number | null; tone: "ok" | "warn" | "full" };

const pctOf = (value: number, max: number) => (max > 0 ? Math.min(100, (value / max) * 100) : value > 0 ? 100 : 0);
const toneOf = (pct: number): UsageLine["tone"] => (pct >= 100 ? "full" : pct >= 80 ? "warn" : "ok");

/**
 * One API's use at a level (SRC ProviderUsage): dollars against the cap for APIs the relay
 * can price (unless only a count limit is set), and a count when limited or not priced.
 */
export function usageLines(level: Pick<LevelView, "bundle" | "spent" | "used" | "reserved">, provider: ProviderId): UsageLine[] {
  const entry = catalogEntry(provider);
  const cap = level.bundle?.caps[provider];
  const max = level.bundle?.maxes?.[provider];
  const spent = level.spent[provider] ?? 0;
  const used = level.used?.[provider] ?? 0;
  const unit = (n: number) => (n === 1 ? countUnit(provider).replace(/s$/, "") : countUnit(provider));
  const showDollars = entry.dollarCaps && (cap !== undefined || max === undefined);
  const showCount = max !== undefined || !entry.dollarCaps;
  const lines: UsageLine[] = [];
  if (showDollars) {
    if (cap !== undefined) {
      const pct = pctOf(spent, cap);
      lines.push({ text: `${usd(spent)} of ${usd(cap)}`, pct, tone: toneOf(pct) });
    } else lines.push({ text: `${usd(spent)} spent, no cap here`, pct: null, tone: "ok" });
  }
  if (showCount) {
    if (max !== undefined) {
      const pct = pctOf(used, max);
      lines.push({ text: `${used} of ${max} ${unit(max)}`, pct, tone: toneOf(pct) });
    } else lines.push({ text: `${used} ${unit(used)}, no limit here`, pct: null, tone: "ok" });
  }
  return lines;
}

/** Dollars held right now by calls still running (streams), when any. */
export const heldText = (level: Pick<LevelView, "reserved">, provider: ProviderId) => {
  const held = level.reserved?.[provider] ?? 0;
  return held > 0 ? `${usd(held)} held by running calls` : null;
};

/** Above the user, an API is worth a line only where that level limits it or something was spent. */
export const limitedOrUsed = (level: LevelView, p: ProviderId) =>
  level.bundle?.caps[p] !== undefined || level.bundle?.maxes?.[p] !== undefined || (level.spent[p] ?? 0) > 0 || (level.used?.[p] ?? 0) > 0;

/** Team, department, company above `user`: nearest first. */
export function aboveLevels(user: string, levels: Record<string, LevelView>): LevelView[] {
  const labels = user.split(".");
  const out: LevelView[] = [];
  for (let i = 1; i < labels.length - 1; i++) {
    const level = levels[labels.slice(i).join(".")];
    if (level) out.push(level);
  }
  return out;
}

export const providerKeys = (level: Pick<LevelView, "bundle"> | null | undefined) => (level?.bundle?.keys ?? []).filter(isProviderId) as ProviderId[];

// --- Which user the live spend panel watches ----------------------------------------

/** A user (depth 3) under `root`, or null. */
export const userUnderRoot = (root: string | null, name: string | null | undefined) =>
  root && name && name.endsWith(`.${root}`) && depthOf(name) === 3 ? name : null;

/**
 * The watched user: a pick from the panel's list wins until the tree selection changes;
 * otherwise the user the selected name belongs to.
 */
export function watchedUser(
  root: string | null,
  selectedUser: string | null,
  pick: { user: string; selectedAt: string | null } | null,
  selectedName: string | null,
): string | null {
  if (pick && pick.selectedAt === selectedName) return userUnderRoot(root, pick.user);
  return userUnderRoot(root, selectedUser);
}

/** The first team in the loaded tree: where to look for users (and add members) before any is picked. */
export const firstTeam = (nodes: readonly { name: string; type: string }[]) => nodes.find((node) => node.type === "team")?.name ?? null;

/** The team whose users the panel lists: the watched user's team, else the first team in the tree. */
export const teamFor = (watched: string | null, fallback: string | null) => (watched ? parentOf(watched) : fallback);

export const STATE_TEXT: Record<LiveState, string> = { live: "live", ended: "ended", revoked: "revoked", gone: "not registered", unknown: "…" };
