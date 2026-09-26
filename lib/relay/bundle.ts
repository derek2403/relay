// Bundles: which provider keys a name may use and how much it may spend.
//
// A bundle is a handful of text records on the resolver that serves the name,
// which by design is the *parent's* resolver, so only the level above can write
// it. The relay reads the bundle of every level from the company root down to
// the calling name and allows a call only if every level allows it.
//
// Shared by the relay (server) and the admin app (browser). Pure: no I/O.

import { CATALOG, PROVIDER_IDS, type ProviderId, countText, isProviderId } from "./catalog";

export { PROVIDER_IDS, isProviderId, type ProviderId };

// Rename here to change every record key (e.g. "xyz.myproject").
export const RECORD_PREFIX = "relay";

export const RECORD_KEYS = {
  keys: `${RECORD_PREFIX}.keys`,
  period: `${RECORD_PREFIX}.period`,
  /** Dollar cap per period. */
  cap: (provider: string) => `${RECORD_PREFIX}.cap.${provider}`,
  /** Count cap per period: requests, or images for image APIs. */
  max: (provider: string) => `${RECORD_PREFIX}.max.${provider}`,
};

/** Every provider in the catalog. `metered` = the relay can price its calls, so dollar caps apply. */
export const PROVIDERS = CATALOG.map((p) => ({ id: p.id as ProviderId, label: p.label as string, metered: p.dollarCaps as boolean }));

export const PERIODS = ["month", "day", "total"] as const;
export type Period = (typeof PERIODS)[number];

export type Bundle = {
  /** Providers this name may use. */
  keys: ProviderId[];
  /** Dollar cap per provider for the current period. A missing cap means no dollar cap at this level. */
  caps: Partial<Record<ProviderId, number>>;
  /** Count cap per provider for the current period (requests, or images). Missing = no count cap. */
  maxes?: Partial<Record<ProviderId, number>>;
  /** How caps reset: calendar month, calendar day (UTC), or never ("total", e.g. an agent session). */
  period: Period;
};

/** Every record key the relay reads for a bundle, in a fixed order. */
export const bundleRecordKeys = (): string[] => [
  RECORD_KEYS.keys,
  RECORD_KEYS.period,
  ...PROVIDER_IDS.map((p) => RECORD_KEYS.cap(p)),
  ...PROVIDER_IDS.map((p) => RECORD_KEYS.max(p)),
];

const parseLimit = (raw: string | null | undefined): number | undefined => {
  if (raw === undefined || raw === null || raw.trim() === "") return undefined;
  const n = Number(raw.trim().replace(/^\$/, ""));
  // An unparseable limit becomes 0 (deny), never "unlimited".
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/**
 * Parses text records into a bundle. Returns null when the name has no
 * `relay.keys` record: no bundle means no access (default deny).
 * Unknown provider ids are dropped.
 */
export function parseBundle(texts: Record<string, string | null | undefined>): Bundle | null {
  const rawKeys = (texts[RECORD_KEYS.keys] ?? "").trim();
  if (!rawKeys) return null;
  const keys = [...new Set(rawKeys.toLowerCase().split(/[\s,]+/).filter(isProviderId))];

  const caps: Bundle["caps"] = {};
  const maxes: NonNullable<Bundle["maxes"]> = {};
  for (const p of PROVIDER_IDS) {
    const cap = parseLimit(texts[RECORD_KEYS.cap(p)]);
    if (cap !== undefined) caps[p] = cap;
    const max = parseLimit(texts[RECORD_KEYS.max(p)]);
    if (max !== undefined) maxes[p] = Math.floor(max);
  }

  const rawPeriod = (texts[RECORD_KEYS.period] ?? "").trim().toLowerCase();
  const period: Period = (PERIODS as readonly string[]).includes(rawPeriod) ? (rawPeriod as Period) : "month";

  return { keys, caps, maxes, period };
}

/**
 * The text records to write for a bundle, including empty values that clear
 * limits no longer set (so an edit never leaves a stale limit behind).
 */
export function bundleToRecords(bundle: Bundle): [key: string, value: string][] {
  const maxes = bundle.maxes ?? {};
  return [
    [RECORD_KEYS.keys, bundle.keys.join(",")],
    [RECORD_KEYS.period, bundle.period],
    ...PROVIDER_IDS.map((p): [string, string] => [RECORD_KEYS.cap(p), bundle.caps[p] === undefined ? "" : String(bundle.caps[p])]),
    ...PROVIDER_IDS.map((p): [string, string] => [RECORD_KEYS.max(p), maxes[p] === undefined ? "" : String(maxes[p])]),
  ];
}

/** Meter bucket for a period: "2026-09", "2026-09-26" (UTC) or "total". */
export function periodKey(period: Period, now: Date = new Date()): string {
  const iso = now.toISOString();
  if (period === "month") return iso.slice(0, 7);
  if (period === "day") return iso.slice(0, 10);
  return "total";
}

export function describeBundle(bundle: Bundle | null): string {
  if (!bundle) return "no access";
  if (bundle.keys.length === 0) return "no keys";
  const parts = bundle.keys.map((k) => {
    const limits = [
      bundle.caps[k] !== undefined ? `$${bundle.caps[k]}` : null,
      bundle.maxes?.[k] !== undefined ? countText(k, bundle.maxes[k]!) : null,
    ].filter(Boolean);
    return limits.length ? `${k} ${limits.join(", ")}` : k;
  });
  return `${parts.join(" · ")} / ${bundle.period}`;
}

// --- Policy ---------------------------------------------------------------

export type LevelInput = {
  name: string;
  bundle: Bundle | null;
  /** Dollars already spent per provider in this level's current period. */
  spent: Partial<Record<ProviderId, number>>;
  /** Count already used per provider in this level's current period (requests or images). */
  used?: Partial<Record<ProviderId, number>>;
};

export type Decision = {
  allowed: boolean;
  /** Why the call was refused, naming the level that refused it. */
  reason: string | null;
  /** Smallest remaining dollar budget across capped levels for this provider, or null if no level caps it. */
  remaining: number | null;
  /** Smallest remaining count across count-capped levels, or null if no level caps the count. */
  remainingCount?: number | null;
};

/**
 * The relay's rule: a provider is usable only if every level from the root to
 * the caller lists it, and every level that caps it (in dollars or in count)
 * still has room. A child can therefore never widen what any ancestor allows.
 */
export function evaluate(levels: LevelInput[], provider: string): Decision {
  if (!isProviderId(provider)) return { allowed: false, reason: `unknown provider "${provider}"`, remaining: null };
  if (levels.length === 0) return { allowed: false, reason: "no levels", remaining: null };

  let remaining: number | null = null;
  let remainingCount: number | null = null;
  for (const level of levels) {
    if (!level.bundle) return { allowed: false, reason: `${level.name} has no bundle`, remaining: null };
    if (!level.bundle.keys.includes(provider)) {
      return { allowed: false, reason: `${level.name} does not allow ${provider}`, remaining: null };
    }
    const cap = level.bundle.caps[provider];
    if (cap !== undefined) {
      const left = cap - (level.spent[provider] ?? 0);
      if (left <= 0) return { allowed: false, reason: `${level.name} has used its ${provider} cap ($${cap})`, remaining: 0 };
      remaining = remaining === null ? left : Math.min(remaining, left);
    }
    const max = level.bundle.maxes?.[provider];
    if (max !== undefined) {
      const left = max - (level.used?.[provider] ?? 0);
      if (left <= 0) {
        return { allowed: false, reason: `${level.name} has used its ${provider} limit (${countText(provider, max)})`, remaining, remainingCount: 0 };
      }
      remainingCount = remainingCount === null ? left : Math.min(remainingCount, left);
    }
  }
  return { allowed: true, reason: null, remaining, remainingCount };
}
