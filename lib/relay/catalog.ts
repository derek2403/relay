// The API catalog: every provider the relay can hold a key for, LiteLLM-style.
// Adding an API is one entry here plus its key in the relay's .env.local.
//
// Shared by the relay (server) and the admin portal (browser). Pure data.

export type Category = "ai" | "dev" | "marketing" | "business" | "data" | "test";

export const CATEGORY_LABELS: Record<Category, string> = {
  ai: "AI",
  dev: "Developer tools",
  marketing: "Marketing",
  business: "Business",
  data: "Data",
  test: "Testing",
};

/** How the relay attaches the real key to the upstream request. */
export type Auth =
  | { kind: "bearer" } // Authorization: Bearer <key>
  | { kind: "header"; name: string } // <name>: <key>
  | { kind: "raw-authorization" } // Authorization: <key> (no scheme)
  | { kind: "none" };

/**
 * How usage is counted:
 * - "tokens": priced from the provider's token usage (Anthropic / OpenAI response formats)
 * - "requests": each forwarded request counts as one (optionally with an estimated $ price)
 * - "images": image generation; counts images (the request's `n`, default 1)
 */
export type Metering =
  | { kind: "tokens"; format: "anthropic" | "openai" }
  | { kind: "requests"; usdPerRequest?: number }
  | { kind: "images"; usdPerImage: number };

export type CatalogEntry = {
  id: string;
  label: string;
  category: Category;
  /** Environment variable holding the real key on the relay; null = no key needed. */
  keyEnv: string | null;
  /** Upstream origin (and optional base path). null = the relay answers itself (mock). */
  upstream: string | null;
  auth: Auth;
  /** Headers the upstream needs if the client didn't send them. */
  defaultHeaders?: Record<string, string>;
  metering: Metering;
  /** True when a dollar cap (relay.cap.<id>) can be enforced: the relay can price calls. */
  dollarCaps: boolean;
  /** Short note shown in the portal. */
  note?: string;
};

export const CATALOG = [
  // --- AI ---------------------------------------------------------------------
  {
    id: "claude",
    label: "Anthropic Claude",
    category: "ai",
    keyEnv: "ANTHROPIC_API_KEY",
    upstream: "https://api.anthropic.com",
    auth: { kind: "header", name: "x-api-key" },
    defaultHeaders: { "anthropic-version": "2023-06-01" },
    metering: { kind: "tokens", format: "anthropic" },
    dollarCaps: true,
  },
  {
    id: "codex",
    label: "OpenAI text (Codex)",
    category: "ai",
    keyEnv: "OPENAI_API_KEY",
    upstream: "https://api.openai.com",
    auth: { kind: "bearer" },
    metering: { kind: "tokens", format: "openai" },
    dollarCaps: true,
    note: "Responses and Chat Completions; prices are estimates unless RELAY_CODEX_PRICES is set",
  },
  {
    id: "openai-images",
    label: "OpenAI Images",
    category: "ai",
    keyEnv: "OPENAI_API_KEY",
    upstream: "https://api.openai.com",
    auth: { kind: "bearer" },
    metering: { kind: "images", usdPerImage: 0.04 },
    dollarCaps: true,
    note: "Image generation; limit by number of images",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    category: "ai",
    keyEnv: "GEMINI_API_KEY",
    upstream: "https://generativelanguage.googleapis.com",
    auth: { kind: "header", name: "x-goog-api-key" },
    metering: { kind: "requests", usdPerRequest: 0.01 },
    dollarCaps: true,
    note: "Priced per request (estimate)",
  },
  // --- Developer tools -------------------------------------------------------
  {
    id: "github",
    label: "GitHub",
    category: "dev",
    keyEnv: "GITHUB_TOKEN",
    upstream: "https://api.github.com",
    auth: { kind: "bearer" },
    defaultHeaders: { "user-agent": "keyless-relay" },
    metering: { kind: "requests" },
    dollarCaps: false,
  },
  {
    id: "railway",
    label: "Railway",
    category: "dev",
    keyEnv: "RAILWAY_TOKEN",
    upstream: "https://backboard.railway.com",
    auth: { kind: "bearer" },
    metering: { kind: "requests" },
    dollarCaps: false,
  },
  {
    id: "vercel",
    label: "Vercel",
    category: "dev",
    keyEnv: "VERCEL_TOKEN",
    upstream: "https://api.vercel.com",
    auth: { kind: "bearer" },
    metering: { kind: "requests" },
    dollarCaps: false,
  },
  {
    id: "linear",
    label: "Linear",
    category: "dev",
    keyEnv: "LINEAR_API_KEY",
    upstream: "https://api.linear.app",
    auth: { kind: "raw-authorization" },
    metering: { kind: "requests" },
    dollarCaps: false,
  },
  // --- Marketing -------------------------------------------------------------
  {
    id: "canva",
    label: "Canva",
    category: "marketing",
    keyEnv: "CANVA_TOKEN",
    upstream: "https://api.canva.com",
    auth: { kind: "bearer" },
    metering: { kind: "requests" },
    dollarCaps: false,
  },
  {
    id: "hubspot",
    label: "HubSpot",
    category: "marketing",
    keyEnv: "HUBSPOT_TOKEN",
    upstream: "https://api.hubapi.com",
    auth: { kind: "bearer" },
    metering: { kind: "requests" },
    dollarCaps: false,
  },
  {
    id: "mailchimp",
    label: "Mailchimp",
    category: "marketing",
    keyEnv: "MAILCHIMP_TOKEN",
    upstream: "https://us1.api.mailchimp.com",
    auth: { kind: "bearer" },
    metering: { kind: "requests" },
    dollarCaps: false,
    note: "Set RELAY_UPSTREAM_MAILCHIMP to your data center's URL",
  },
  // --- Business --------------------------------------------------------------
  {
    id: "stripe",
    label: "Stripe",
    category: "business",
    keyEnv: "STRIPE_SECRET_KEY",
    upstream: "https://api.stripe.com",
    auth: { kind: "bearer" },
    metering: { kind: "requests" },
    dollarCaps: false,
  },
  {
    id: "notion",
    label: "Notion",
    category: "business",
    keyEnv: "NOTION_TOKEN",
    upstream: "https://api.notion.com",
    auth: { kind: "bearer" },
    defaultHeaders: { "notion-version": "2022-06-28" },
    metering: { kind: "requests" },
    dollarCaps: false,
  },
  {
    id: "slack",
    label: "Slack",
    category: "business",
    keyEnv: "SLACK_BOT_TOKEN",
    upstream: "https://slack.com/api",
    auth: { kind: "bearer" },
    metering: { kind: "requests" },
    dollarCaps: false,
  },
  // --- Data ------------------------------------------------------------------
  {
    // Open-Meteo's forecast API: free, no key. Read-only (routes.ts forwards GET /v1/<endpoint> only);
    // each call counts one request, so relay.max.weather caps it.
    id: "weather",
    label: "Weather (Open-Meteo)",
    category: "data",
    keyEnv: null,
    upstream: "https://api.open-meteo.com",
    auth: { kind: "none" },
    metering: { kind: "requests" },
    dollarCaps: false,
    note: "No key needed. Current weather and forecasts by latitude/longitude.",
  },
  // --- Testing ---------------------------------------------------------------
  {
    id: "mock",
    label: "Mock (test, $0.01 per call)",
    category: "test",
    keyEnv: null,
    upstream: null,
    auth: { kind: "none" },
    metering: { kind: "requests", usdPerRequest: 0.01 },
    dollarCaps: true,
  },
] as const satisfies readonly CatalogEntry[];

export type ProviderId = (typeof CATALOG)[number]["id"];

export const PROVIDER_IDS = CATALOG.map((p) => p.id) as ProviderId[];

export const isProviderId = (id: string): id is ProviderId => (PROVIDER_IDS as string[]).includes(id);

export const catalogEntry = (id: ProviderId): CatalogEntry => CATALOG.find((p) => p.id === id)! as CatalogEntry;

/** The unit a count limit (relay.max.<id>) counts, for display: "images" or "requests". */
export const countUnit = (id: ProviderId) => (catalogEntry(id).metering.kind === "images" ? "images" : "requests");

/** A count with its unit, singular for 1: "1 image", "5 requests". */
export const countText = (id: ProviderId, n: number) => `${n} ${n === 1 ? countUnit(id).slice(0, -1) : countUnit(id)}`;
