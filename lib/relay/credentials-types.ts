// Service credentials: the JSON shapes of /api/relay/credentials and the list
// of editable slots, built from the catalog. Pure and browser-safe (no secrets,
// no node modules), so the admin UI can import it.
//
// A slot is one environment variable the relay reads: a catalog key variable
// (OPENAI_API_KEY is shared by codex and openai-images) or a non-secret upstream
// override (RELAY_UPSTREAM_MAILCHIMP). Stored values override the process
// environment; clearing one restores what the environment had.

import type { Address } from "viem";

import { CATALOG } from "./catalog";

export type CredentialSource = "store" | "env" | null;

/** One editable variable. */
export type CredentialSlot = {
  /** Environment variable name, e.g. "OPENAI_API_KEY". */
  env: string;
  label: string;
  /** Catalog ids that use it. */
  apis: string[];
  /** false for non-secret settings (an upstream URL): the owner sees the value. */
  secret: boolean;
  kind: "key" | "upstream";
  placeholder: string;
};

/** GET /api/relay/credentials: one variable. Never carries a secret value. */
export type CredentialKeyView = {
  env: string;
  label: string;
  apis: string[];
  secret: boolean;
  kind: "key" | "upstream";
  placeholder: string;
  /** A value is in effect (stored, or from the relay's environment). */
  set: boolean;
  /** Where the value in effect comes from. */
  source: CredentialSource;
  /** When the stored value was last written (ms since epoch); null when nothing is stored. */
  updatedAt: number | null;
  /** Redacted value ("sk-p••••••••3f2a"), only for the signed-in owner or the admin. */
  hint: string | null;
  /** Non-secret slots only, only for the owner or the admin: the value in effect. */
  value?: string;
};

/** A credential-only service added in the portal ("Add a provider"): stored, never routed. */
export type CustomServiceView = {
  id: string;
  label: string;
  set: boolean;
  /** ms since epoch. */
  updatedAt: number | null;
  hint: string | null;
  /** Free-text note (e.g. its base URL); only for the owner or the admin. */
  note?: string | null;
  /** Only on the DELETE response. */
  deleted?: true;
};

export type OwnerSession = {
  address: Address;
  /** ms since epoch. */
  expiresAt: number;
};

/** GET /api/relay/credentials */
export type CredentialsResponse = {
  /** The wallet signed in with its root-owner session cookie, or null. */
  owner: OwnerSession | null;
  /** The request carries the relay admin token or cookie (RELAY_ADMIN_TOKEN). */
  admin: boolean;
  /** RELAY_SECRET is set and long enough: sign-in and writes are possible. */
  secretConfigured: boolean;
  /** RELAY_ROOT_NAME; the owner of this name may sign in. */
  root: string | null;
  /** Set when the stored credentials can't be read (wrong RELAY_SECRET, damaged file); writes are refused. */
  storeError: string | null;
  keys: CredentialKeyView[];
  custom: CustomServiceView[];
};

/** GET /api/relay/credentials/nonce?address=0x… */
export type NonceResponse = {
  nonce: string;
  /** The exact text to sign with personal_sign (an EIP-4361 message). */
  message: string;
  /** ms since epoch. */
  expiresAt: number;
};

/** POST /api/relay/credentials/session */
export type SessionResponse = { owner: OwnerSession | null };

/** Readable names for key variables shared by several APIs. */
const SHARED_LABELS: Record<string, string> = { OPENAI_API_KEY: "OpenAI API key" };

const PLACEHOLDERS: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-…",
  OPENAI_API_KEY: "sk-proj-…",
  GEMINI_API_KEY: "AIza…",
  GITHUB_TOKEN: "github_pat_…",
  LINEAR_API_KEY: "lin_api_…",
  STRIPE_SECRET_KEY: "sk_live_… or rk_live_…",
  SLACK_BOT_TOKEN: "xoxb-…",
  NOTION_TOKEN: "ntn_…",
};

/** Non-secret upstream overrides the owner may set (the value is checked against `pattern`). */
export const UPSTREAM_SLOTS = [
  {
    env: "RELAY_UPSTREAM_MAILCHIMP",
    api: "mailchimp",
    label: "Mailchimp data center URL",
    placeholder: "https://us21.api.mailchimp.com",
  },
] as const;

/** Every editable slot: one per distinct catalog key variable, then the upstream overrides. */
export function credentialSlots(): CredentialSlot[] {
  const byEnv = new Map<string, CredentialSlot>();
  for (const entry of CATALOG) {
    if (!entry.keyEnv) continue;
    const slot = byEnv.get(entry.keyEnv);
    if (slot) {
      slot.apis.push(entry.id);
      continue;
    }
    byEnv.set(entry.keyEnv, {
      env: entry.keyEnv,
      label: SHARED_LABELS[entry.keyEnv] ?? `${entry.label} key`,
      apis: [entry.id],
      secret: true,
      kind: "key",
      placeholder: PLACEHOLDERS[entry.keyEnv] ?? "",
    });
  }
  const upstreams: CredentialSlot[] = UPSTREAM_SLOTS.map((u) => ({
    env: u.env,
    label: u.label,
    apis: [u.api],
    secret: false,
    kind: "upstream",
    placeholder: u.placeholder,
  }));
  return [...byEnv.values(), ...upstreams];
}

/** The slot for an environment variable name, or null when it isn't editable. */
export const slotFor = (env: string): CredentialSlot | null => credentialSlots().find((s) => s.env === env) ?? null;
