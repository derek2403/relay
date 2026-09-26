// Pure helpers behind components/live/BundleEditor.tsx (SRC app/_components/BundleEditor.tsx).
// Browser-safe: only lib/relay/{browser,bundle,catalog}.

import { providerMark } from "@/lib/provider-marks";
import { type BundleDraft, type LevelBundle, type LimitsAbove, bundleFromDraft, limitsAbove } from "@/lib/relay/browser";
import type { Bundle, Period } from "@/lib/relay/bundle";
import { CATALOG, CATEGORY_LABELS, type Category, type ProviderId, countUnit } from "@/lib/relay/catalog";

export const PERIOD_LABELS: Record<Period, string> = {
  month: "per month",
  day: "per day",
  total: "in total (never resets)",
};

const CATEGORIES = Object.keys(CATEGORY_LABELS) as Category[];

/** Brand mark (or stroke icon) for a catalog API, for <Icon name=…/>. */
export const catalogIcon = providerMark;

/** "Stripe", "Stripe and Notion", "Stripe, Notion and Slack". */
export const listOf = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/** A typed limit as a number; null when empty or not a number (SRC `number`). */
export function parseLimit(raw: string | undefined): number | null {
  const text = (raw ?? "").trim();
  const n = Number(text.replace(/^\$/, ""));
  return text !== "" && Number.isFinite(n) ? n : null;
}

/**
 * The levels above the edited name, company first.
 * - `above` (SRC semantics) wins: undefined = no levels (the company itself), null = still loading.
 * - Otherwise a single `parent` bundle stands for the level above. A missing/null parent means
 *   "nothing known", so nothing is flagged; pass `above` with a null bundle for the relay's default deny.
 */
export function levelsAbove(opts: { above?: LevelBundle[] | null; parent?: Bundle | null; parentName?: string }): LevelBundle[] | null | undefined {
  if (opts.above !== undefined) return opts.above;
  if (!opts.parent) return undefined;
  return [{ name: opts.parentName || "the parent", bundle: opts.parent }];
}

export type BundleRow = {
  id: ProviderId;
  label: string;
  icon: string;
  on: boolean;
  /** A $ input is shown only for APIs the relay can price (catalog dollarCaps). */
  showCap: boolean;
  /** Count limits (relay.max.<id>) apply to every API. */
  showMax: boolean;
  unit: "images" | "requests";
  cap: string;
  max: string;
  capPlaceholder: string;
  maxPlaceholder: string;
  /** Warnings about the levels above (only while the API is ticked). */
  notes: string[];
};

export type BundleGroup = { category: Category; label: string; rows: BundleRow[] };

export type BundleEditorModel = {
  /** The levels above are still loading. */
  loading: boolean;
  groups: BundleGroup[];
  /** "Stripe and Notion aren't available: eng.acme.eth doesn't allow them." */
  unavailable: string[];
};

/** Warnings for one ticked API against the limits above (SRC ProviderRow notes). */
export function rowNotes(id: ProviderId, draft: { on: boolean; cap: string; max: string }, limits: LimitsAbove | null): string[] {
  if (!draft.on || !limits) return [];
  const entry = CATALOG.find((p) => p.id === id);
  const unit = countUnit(id);
  const capNum = parseLimit(draft.cap);
  const maxNum = parseLimit(draft.max);
  const notes: string[] = [];
  if (limits.blockedBy) notes.push(`Blocked above: ${limits.blockedBy} doesn't allow it.`);
  if (entry?.dollarCaps && limits.cap && capNum !== null && capNum > limits.cap.value) notes.push(`Capped by ${limits.cap.by} at $${limits.cap.value}.`);
  if (limits.max && maxNum !== null && maxNum > limits.max.value) notes.push(`Capped by ${limits.max.by} at ${limits.max.value} ${unit}.`);
  return notes;
}

/**
 * What the editor shows: APIs grouped by category, blocked ones hidden unless already ticked
 * (so they can be unticked), and per-row inputs, placeholders and warnings.
 */
export function bundleEditorModel(value: BundleDraft, above: LevelBundle[] | null | undefined): BundleEditorModel {
  const limits = new Map<ProviderId, LimitsAbove | null>(CATALOG.map((p) => [p.id as ProviderId, above ? limitsAbove(above, p.id) : null]));
  const blocked = (id: ProviderId) => !!limits.get(id)?.blockedBy;
  const shown = CATALOG.filter((p) => !blocked(p.id) || value.keys.includes(p.id));
  const hidden = CATALOG.filter((p) => blocked(p.id) && !value.keys.includes(p.id));

  const byLevel = new Map<string, string[]>();
  for (const p of hidden) {
    const by = limits.get(p.id)!.blockedBy!;
    byLevel.set(by, [...(byLevel.get(by) ?? []), p.label]);
  }
  const unavailable = [...byLevel].map(
    ([by, labels]) => `${listOf(labels)} ${labels.length === 1 ? "isn't" : "aren't"} available: ${by} doesn't allow ${labels.length === 1 ? "it" : "them"}.`,
  );

  const groups: BundleGroup[] = [];
  for (const category of CATEGORIES) {
    const rows = shown
      .filter((p) => p.category === category)
      .map((p): BundleRow => {
        const id = p.id as ProviderId;
        const lim = limits.get(id) ?? null;
        const on = value.keys.includes(id);
        const cap = value.caps[id] ?? "";
        const max = value.maxes[id] ?? "";
        return {
          id,
          label: p.label,
          icon: catalogIcon(id),
          on,
          showCap: p.dollarCaps,
          showMax: true,
          unit: countUnit(id),
          cap,
          max,
          capPlaceholder: lim?.cap ? `≤ ${lim.cap.value}` : "no cap",
          maxPlaceholder: lim?.max ? `≤ ${lim.max.value}` : "no limit",
          notes: rowNotes(id, { on, cap, max }, lim),
        };
      });
    if (rows.length > 0) groups.push({ category, label: CATEGORY_LABELS[category], rows });
  }

  return { loading: above === null, groups, unavailable };
}

// --- Draft edits (immutable) --------------------------------------------------------

export const toggleKey = (d: BundleDraft, id: ProviderId, on: boolean): BundleDraft => ({
  ...d,
  keys: on ? (d.keys.includes(id) ? d.keys : [...d.keys, id]) : d.keys.filter((k) => k !== id),
});

export const setCap = (d: BundleDraft, id: ProviderId, raw: string): BundleDraft => ({ ...d, caps: { ...d.caps, [id]: raw } });

export const setMax = (d: BundleDraft, id: ProviderId, raw: string): BundleDraft => ({ ...d, maxes: { ...d.maxes, [id]: raw } });

export const setPeriod = (d: BundleDraft, period: Period): BundleDraft => ({ ...d, period });

/** The bundle a draft describes, or the error to show (lib/relay/browser bundleFromDraft). */
export const validateDraft = bundleFromDraft;
