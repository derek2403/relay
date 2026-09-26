// Pure helpers for the live Policies view (plans and delegates). No React, no I/O, so tests can import them.

import { type Address, isAddress, isAddressEqual } from "viem";

import { tryNormalize } from "@/lib/ens/names";
import { ResolverRoles } from "@/lib/ens/roles";
import { planName } from "@/lib/relay/browser";
import { PROVIDERS } from "@/lib/relay/bundle";
import { isListed } from "@/lib/relay/catalog";

// --- Plans -------------------------------------------------------------------

export const PLAN_SLUG_ERROR = "Use letters, numbers and dashes.";

export type PlanSlug = { slug: string | null; error: string | null };

/** Normalizes a typed plan name; only letters, numbers and dashes are allowed (SRC Plans). */
export function parsePlanSlug(input: string): PlanSlug {
  const slug = tryNormalize(input);
  const valid = !!slug && /^[a-z0-9-]+$/.test(slug);
  return { slug: valid ? slug : null, error: input && !valid ? PLAN_SLUG_ERROR : null };
}

/** Full plan record name (plan-<slug>.<parent>), or null until both parts are valid. */
export function planTarget(input: string, parent: string | null): string | null {
  const { slug } = parsePlanSlug(input);
  return parent && slug ? planName(slug, parent) : null;
}

/** "plan-standard.acme.eth" → "standard". */
export const planSlugOf = (plan: string) => plan.split(".")[0].replace(/^plan-/, "");

/** Saved plans for people under `parent` (the list in this browser holds every level's plans). */
export const plansUnder = (plans: readonly string[], parent: string | null): string[] =>
  parent ? plans.filter((p) => p.endsWith(`.${parent}`)) : [];

/** The saved list with `plan` added once. */
export const withPlan = (plans: readonly string[], plan: string): string[] => (plans.includes(plan) ? [...plans] : [...plans, plan]);

// --- Your level ----------------------------------------------------------------

export type LevelCandidate = { name: string | null; iOwn: boolean; subregistry: string | null };

/**
 * Plans and delegates act on "your" level (SRC AdminApp): the selected name if you own it and it
 * has people under it (a subregistry), otherwise the company root if it's yours, else nothing.
 */
export function pickMyLevel<T extends LevelCandidate>(selected: T | null, root: T | null): T | null {
  if (selected?.name && selected.iOwn && selected.subregistry) return selected;
  if (root?.name && root.iOwn && root.subregistry) return root;
  return null;
}

// --- Delegates -------------------------------------------------------------------

/** Providers with a dollar cap record (relay.cap.<id>), the ones a delegate may be given. */
export const DELEGATABLE = PROVIDERS.filter((p) => p.metered && isListed(p.id));

/** A typed address, or null when it isn't a valid (checksummed if mixed-case) address. */
export const parseDelegate = (input: string): Address | null => {
  const value = input.trim();
  return isAddress(value) ? (value as Address) : null;
};

/** The company's limits live on your resolver too, so a grant also covers the company-wide cap. */
export const coversCompany = (companyResolver: Address | null | undefined, myResolver: Address | null | undefined) =>
  !!companyResolver && !!myResolver && isAddressEqual(companyResolver, myResolver);

/** Whether a roles bitmap includes ROLE_SET_TEXT; undefined while unread. */
export const canSetText = (roles: bigint | undefined): boolean | undefined =>
  roles === undefined ? undefined : (roles & ResolverRoles.ROLE_SET_TEXT) !== 0n;

/** What a grant reaches (SRC Delegates notice). */
export const delegateScope = (company: boolean) =>
  `They can change that cap on every name whose limits live on your resolver: the people and agents you added${
    company ? ", your plans, and the company-wide limit" : " and your plans"
  }.`;

/** How the delegate uses it (SRC Delegates footer). */
export const delegateHowTo = (company: boolean) =>
  `They change it from this page: select the name in the team tree${
    company ? " (the company row for the company-wide limit)" : ""
  } and use "Change a cap".`;
