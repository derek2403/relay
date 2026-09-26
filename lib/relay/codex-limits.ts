// Codex's own usage-limit display, fed from the relay's ENS caps.
//
// Codex (0.157) reads x-codex-* headers on every /v1/responses answer and, in
// the TUI, shows a warning line at 75%, 90% and 95% used and a footer above
// the composer ("⚠ daily limit: 20% left · resets at …") from 75% on. Below
// 75% nothing is shown, and /status never shows these in API-key mode.
//
// The numbers are the relay's own: the codex dollar cap of the level that
// will stop the caller first (least left, counting only settled spend, so an
// estimate held for a running call never shows), its period and when it
// resets. A refused call names the level that actually refused it, read at
// refusal time with what running calls hold, as reservations count it. A
// spent cap on a Codex login answers 429 usage_limit_reached, which Codex
// shows without retrying:
//   "You've hit your usage limit. <promo>, or try again at <reset>."
// (or "..., or try again later." when running calls hold what's left).
// Credits headers and x-codex-limit-name are never sent (they hide the
// warnings or change the message).

import type { Meter } from "./meter";
import { type PolicyDecision, available, spendLevels, spentOn } from "./policy";

export type CapUsage = {
  /** The level whose cap this is (or the approved scope's label). */
  name: string;
  cap: number;
  /** Settled dollars in the current period. */
  spent: number;
  /** Dollars held for calls still running (their worst case, released when they settle). */
  held: number;
  /** 1440 (daily) or 43200 (monthly); null for a one-off cap ("total", an approved scope). */
  windowMinutes: number | null;
  /** When the cap resets (unix s): the next period, or the name's (scope's) end for a one-off cap. */
  resetAt: number | null;
  /** Who can raise it: the name above the capped level. */
  raiser: string | null;
};

const WINDOW_MINUTES = { day: 1440, month: 43200, total: null } as const;

function periodEnd(period: "day" | "month", now: Date): number {
  const next =
    period === "day"
      ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
      : Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.floor(next / 1000);
}

/**
 * The codex cap that binds first across a decision's levels and approved scopes, or null when none caps codex.
 * "settled" picks it by settled spend alone (Codex's usage display, which then doesn't jump while calls run);
 * "held" also counts what running calls hold, as a reservation does (a refused call's message).
 */
export function codexCapUsage(decision: Pick<PolicyDecision, "levels" | "overlays">, meter: Meter, now: Date, by: "settled" | "held" = "settled"): CapUsage | null {
  let best: (CapUsage & { left: number }) | null = null;
  for (const level of spendLevels(decision)) {
    const cap = level.bundle?.caps.codex;
    if (cap === undefined) continue;
    const spent = spentOn(level, "codex", meter, now);
    // What a new call can still reserve here: the cap less settled spend and running calls' holds.
    const free = available([level], "codex", meter, now)!;
    const held = Math.max(0, Math.round((cap - spent - free) * 1e9) / 1e9);
    const left = by === "held" ? free : cap - spent;
    let usage: CapUsage;
    if (level.bucket !== undefined) {
      const scope = decision.overlays.find((o) => o.bucket === level.bucket);
      usage = { name: level.label ?? level.name, cap, spent, held, windowMinutes: null, resetAt: scope && Number.isFinite(scope.notAfter) ? scope.notAfter : null, raiser: null };
    } else {
      const period = level.bundle!.period;
      const i = decision.levels.findIndex((l) => l.name === level.name);
      const expiry = decision.levels[i]?.expiry ?? null;
      usage = {
        name: level.name,
        cap,
        spent,
        held,
        windowMinutes: WINDOW_MINUTES[period],
        resetAt: period === "total" ? expiry : periodEnd(period, now),
        raiser: i > 0 ? decision.levels[i - 1].name : null,
      };
    }
    // Ties go to the deeper level: it is the one the caller's own owner set.
    if (!best || left <= best.left) best = { ...usage, left };
  }
  if (!best) return null;
  const { left: _left, ...usage } = best;
  return usage;
}

export const usedPercent = (u: Pick<CapUsage, "cap" | "spent">) => (u.cap > 0 ? Math.min(100, Math.max(0, Math.round((u.spent / u.cap) * 1000) / 10)) : 100);

/** The headers Codex reads for its usage display; empty when nothing caps codex. */
export function codexLimitHeaders(u: CapUsage | null, nowSec = Math.floor(Date.now() / 1000)): Record<string, string> {
  if (!u) return {};
  const h: Record<string, string> = { "x-codex-primary-used-percent": String(usedPercent(u)) };
  if (u.windowMinutes !== null) h["x-codex-primary-window-minutes"] = String(u.windowMinutes);
  if (u.resetAt !== null && u.resetAt > nowSec) h["x-codex-primary-reset-at"] = String(u.resetAt);
  return h;
}

const usd = (n: number) => `$${n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
/** Header values are ByteStrings: anything outside printable ASCII (a Unicode ENS label) becomes "?". */
const headerText = (s: string) => s.replace(/[^\x20-\x7e]/g, "?").slice(0, 400);

// Less than half a cent reads as nothing.
const HALF_CENT = 0.005;
/** Money is left but calls still running hold some of it (their worst case, freed when they end). */
const heldUp = (u: CapUsage) => u.cap - u.spent >= HALF_CENT && u.held >= HALF_CENT;

/** What Codex puts after "You've hit your usage limit." */
export function usagePromo(u: CapUsage | null, reason: string): string {
  if (!u) return headerText(reason);
  const raise = u.raiser ? `. Ask ${u.raiser} to raise it` : "";
  const left = u.cap - u.spent;
  const what =
    left < HALF_CENT
      ? `has used its ${usd(u.cap)} Codex cap`
      : heldUp(u)
        ? `has ${usd(left)} of its ${usd(u.cap)} Codex cap left, but calls still running hold ${usd(Math.min(u.held, left))} of it until they finish`
        : `has ${usd(left)} of its ${usd(u.cap)} Codex cap left, too little for another call`;
  return headerText(`${u.name} ${what}${raise}`);
}

/**
 * The 429 Codex shows as "You've hit your usage limit" without retrying. `reason` (the relay's own
 * refusal) is in the body for other clients; Codex shows the promo header instead. A cap held up by
 * running calls sends no resets_at (Codex then ends with "or try again later", not the cap's reset)
 * and its real used percent, since money is still left.
 */
export function usageLimitResponse(u: CapUsage | null, reason: string, nowSec = Math.floor(Date.now() / 1000)): Response {
  const held = u !== null && heldUp(u);
  const resetsAt = !held && u?.resetAt && u.resetAt > nowSec ? u.resetAt : undefined;
  const error = { type: "usage_limit_reached", code: "usage_limit_reached", message: reason, ...(resetsAt ? { resets_at: resetsAt } : {}) };
  return Response.json(
    { error },
    {
      status: 429,
      headers: {
        "cache-control": "no-store",
        ...codexLimitHeaders(u, nowSec),
        ...(u && !held ? { "x-codex-primary-used-percent": "100" } : {}),
        "x-codex-promo-message": usagePromo(u, reason),
      },
    },
  );
}
