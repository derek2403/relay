// Which provider requests the relay forwards, and how each one is charged.
//
// Providers the relay prices from the request (Claude and Codex by tokens,
// OpenAI Images per image, Gemini per request) only get the endpoints the
// relay knows how to price: anything else (batches, fine-tuning, files, audio,
// stored-object reads) could spend money the meter can't see. Weather
// (OpenWeatherMap, the relay adds ?appid=<key>) is read-only: GET /data/2.5/<endpoint>
// and /geo/1.0/<endpoint>, one request each.
// Operators can add routes with RELAY_EXTRA_ROUTES.
//
// Every other catalog provider gets any method and path, and each request
// counts as one (priced at the catalog's $/request, if any), except requests
// that create credentials, webhooks or integrations, change who has access, or
// revoke the relay's own key (routeDenial below). Those outlive the agent's ENS
// name, or cut everyone off: removing the name cuts the relay path, not a deploy
// key or webhook the agent added. This is a second line of defense; the tokens
// themselves should be tightly scoped (fine-grained GitHub PAT, Railway project
// token, restricted Stripe key, and so on).

import { type ProviderId, catalogEntry } from "./catalog";
import type { ExtraRoute } from "./config";

/**
 * - "generate" / "embed": priced from token usage (Claude, Codex)
 * - "images": counts the request's `n` images, priced per image
 * - "request": counts one request, priced per request (or $0)
 * - "free": forwarded without charge (model lists, token counts)
 */
export type RouteKind = "generate" | "embed" | "images" | "request" | "free";

/** Request shapes the relay can price before sending. "custom" = an operator-added metered route. */
export type RouteApi = "anthropic-messages" | "openai-responses" | "openai-chat" | "openai-embeddings" | "custom";

export type RouteMatch = { kind: RouteKind; api: RouteApi | null };

type Rule = { method: string; pattern: string; kind: RouteKind; api?: RouteApi };

const MODELS: Rule[] = [
  { method: "GET", pattern: "/v1/models", kind: "free" },
  { method: "GET", pattern: "/v1/models/*", kind: "free" },
];

/** Providers restricted to known endpoints. The rest forward any request. */
const ROUTES: Partial<Record<ProviderId, Rule[]>> = {
  claude: [
    { method: "POST", pattern: "/v1/messages", kind: "generate", api: "anthropic-messages" },
    { method: "POST", pattern: "/v1/messages/count_tokens", kind: "free" },
    ...MODELS,
  ],
  codex: [
    { method: "POST", pattern: "/v1/responses", kind: "generate", api: "openai-responses" },
    { method: "POST", pattern: "/v1/chat/completions", kind: "generate", api: "openai-chat" },
    { method: "POST", pattern: "/v1/embeddings", kind: "embed", api: "openai-embeddings" },
    ...MODELS,
  ],
  "openai-images": [
    { method: "POST", pattern: "/v1/images/generations", kind: "images" },
    { method: "POST", pattern: "/v1/images/edits", kind: "images" },
    ...MODELS,
  ],
  // Gemini model methods are "<model>:<method>" in one path segment.
  gemini: ["v1beta", "v1"].flatMap((v): Rule[] => [
    { method: "POST", pattern: `/${v}/models/*:generateContent`, kind: "request" },
    { method: "POST", pattern: `/${v}/models/*:streamGenerateContent`, kind: "request" },
    { method: "POST", pattern: `/${v}/models/*:countTokens`, kind: "request" },
    { method: "GET", pattern: `/${v}/models`, kind: "free" },
    { method: "GET", pattern: `/${v}/models/*`, kind: "free" },
  ]),
  // OpenWeatherMap: current weather and forecasts (/data/2.5/*) and geocoding (/geo/1.0/*). Reads only.
  weather: [
    { method: "GET", pattern: "/data/2.5/*", kind: "request" },
    { method: "GET", pattern: "/geo/1.0/*", kind: "request" },
  ],
};

/** Decoded path segments of a raw (percent-encoded, already validated) relay path, without a trailing empty segment. */
export function pathSegments(rawPath: string): string[] {
  const parts = rawPath.split("/").filter((s, i, all) => !(s === "" && (i === 0 || i === all.length - 1)));
  return parts.map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

/** `*` matches one segment; `*:suffix` matches one segment ending in ":suffix" (Gemini's "<model>:generateContent"). */
const segmentMatches = (want: string, seg: string) => {
  if (want === "*") return true;
  if (want.startsWith("*:")) return seg.length > want.length - 1 && seg.endsWith(want.slice(1));
  return want === seg;
};

const matches = (pattern: string, segments: string[]) => {
  const want = pattern.split("/").filter(Boolean);
  return want.length === segments.length && want.every((w, i) => segmentMatches(w, segments[i]));
};

/** What an operator-added "metered" route is charged like: the provider's own paid calls. */
function meteredKind(provider: ProviderId): RouteMatch {
  const metering = catalogEntry(provider).metering;
  if (metering.kind === "tokens") return { kind: "generate", api: "custom" };
  if (metering.kind === "images") return { kind: "images", api: null };
  return { kind: "request", api: null };
}

/**
 * The route a request hits and how it is charged, or null when the relay
 * doesn't forward it. Providers without a route table forward everything,
 * each request counting as one.
 */
export function routeFor(provider: ProviderId, method: string, segments: string[], extra: ExtraRoute[] = []): RouteMatch | null {
  if (catalogEntry(provider).typedOnly) return null;
  const table = ROUTES[provider];
  if (!table) return { kind: "request", api: null };
  const m = method === "HEAD" ? "GET" : method;
  const rule = table.find((r) => r.method === m && matches(r.pattern, segments));
  if (rule) return { kind: rule.kind, api: rule.api ?? null };
  const added = extra.find((r) => r.provider === provider && r.method === m && matches(r.pattern, segments));
  if (added) return added.kind === "free" ? { kind: "free", api: null } : meteredKind(provider);
  return null;
}

export const allowedRoutesText = (provider: ProviderId, extra: ExtraRoute[] = []) =>
  [...(ROUTES[provider] ?? []), ...extra.filter((r) => r.provider === provider)].map((r) => `${r.method} ${r.pattern}`).join(", ");

// --- GraphQL -----------------------------------------------------------------

type Token = { t: "name" | "punct" | "other"; v: string };

function tokenize(src: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/[\s,﻿]/.test(c)) {
      i++;
    } else if (c === "#") {
      while (i < src.length && src[i] !== "\n" && src[i] !== "\r") i++;
    } else if (src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      if (end < 0) return null;
      i = end + 3;
      out.push({ t: "other", v: "str" });
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") i++;
        if (src[i] === "\n") return null;
        i++;
      }
      if (i >= src.length) return null;
      i++;
      out.push({ t: "other", v: "str" });
    } else if (src.startsWith("...", i)) {
      out.push({ t: "punct", v: "..." });
      i += 3;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ t: "name", v: src.slice(i, j) });
      i = j;
    } else if ("{}()[]:=@$!|&".includes(c)) {
      out.push({ t: "punct", v: c });
      i++;
    } else if (/[-0-9.]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j++;
      out.push({ t: "other", v: "num" });
      i = j;
    } else {
      return null;
    }
  }
  return out;
}

export type GraphqlOperation = { type: "query" | "mutation" | "subscription"; fields: string[]; spreads: boolean };

/** Skips a balanced (...) / {...} / [...] group starting at `i`; returns the index after it, or -1. */
function skipGroup(tokens: Token[], i: number): number {
  const open = tokens[i].v;
  const close = open === "(" ? ")" : open === "{" ? "}" : "]";
  let depth = 0;
  for (let j = i; j < tokens.length; j++) {
    if (tokens[j].t !== "punct") continue;
    if (tokens[j].v === open) depth++;
    else if (tokens[j].v === close && --depth === 0) return j + 1;
  }
  return -1;
}

/** Operations in a GraphQL document with their top-level field names; null when it can't be read. */
export function graphqlOperations(doc: string): GraphqlOperation[] | null {
  const tokens = tokenize(doc);
  if (!tokens) return null;
  const ops: GraphqlOperation[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    let type: GraphqlOperation["type"];
    if (tok.t === "punct" && tok.v === "{") {
      type = "query";
    } else if (tok.t === "name" && (tok.v === "query" || tok.v === "mutation" || tok.v === "subscription")) {
      type = tok.v;
      i++;
      // Optional name, variables and directives up to the selection set.
      while (i < tokens.length && !(tokens[i].t === "punct" && tokens[i].v === "{")) {
        if (tokens[i].t === "punct" && tokens[i].v === "(") {
          i = skipGroup(tokens, i);
          if (i < 0) return null;
        } else i++;
      }
    } else if (tok.t === "name" && tok.v === "fragment") {
      while (i < tokens.length && !(tokens[i].t === "punct" && tokens[i].v === "{")) i++;
      if (i >= tokens.length) return null;
      i = skipGroup(tokens, i);
      if (i < 0) return null;
      continue;
    } else {
      return null;
    }
    if (i >= tokens.length) return null;
    const end = skipGroup(tokens, i);
    if (end < 0) return null;
    // Top-level selections: [alias:] field [(args)] [@directive(args)] [{...}] | ...Fragment | ... on T {...}
    const op: GraphqlOperation = { type, fields: [], spreads: false };
    let j = i + 1;
    while (j < end - 1) {
      const t = tokens[j];
      if (t.t === "punct" && t.v === "...") {
        op.spreads = true;
        j++;
      } else if (t.t === "punct" && (t.v === "(" || t.v === "{")) {
        j = skipGroup(tokens, j);
        if (j < 0) return null;
      } else if (t.t === "punct" && t.v === "@") {
        j += 2;
      } else if (t.t === "name") {
        const aliased = tokens[j + 1]?.t === "punct" && tokens[j + 1].v === ":";
        const field = aliased ? tokens[j + 2] : t;
        if (!field || field.t !== "name") return null;
        if (!(tokens[j - 1]?.t === "punct" && tokens[j - 1].v === "...")) op.fields.push(field.v);
        j += aliased ? 3 : 1;
      } else {
        j++;
      }
    }
    ops.push(op);
    i = end;
  }
  return ops;
}

/** The GraphQL documents in a request body (a single request or a batch); null when there are none to read. */
function graphqlDocuments(body: Uint8Array | null): string[] | null {
  if (!body || !body.byteLength) return null;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  const items = Array.isArray(json) ? json : [json];
  const docs: string[] = [];
  for (const item of items) {
    const query = (item as { query?: unknown } | null)?.query;
    // Persisted queries (a hash, no text) can't be checked.
    if (typeof query !== "string") return null;
    docs.push(query);
  }
  return docs.length ? docs : null;
}

/**
 * Checks every mutation in a GraphQL body with `allow(field)`. Queries pass;
 * subscriptions, fragment spreads inside mutations and unreadable bodies are refused.
 */
function graphqlDenial(provider: string, body: Uint8Array | null, allow: (field: string) => boolean): string | null {
  const docs = graphqlDocuments(body);
  if (!docs) return `the relay couldn't read this ${provider} GraphQL request (send JSON with a "query" string)`;
  for (const doc of docs) {
    const ops = graphqlOperations(doc);
    if (!ops) return `the relay couldn't parse this ${provider} GraphQL document`;
    for (const op of ops) {
      if (op.type === "subscription") return `${provider} GraphQL subscriptions are not forwarded`;
      if (op.type !== "mutation") continue;
      if (op.spreads) return `${provider} GraphQL mutations must list their fields directly (no fragments)`;
      const bad = op.fields.find((f) => !allow(f));
      if (bad) return `the relay doesn't forward the ${provider} mutation "${bad}": it could create credentials or change who has access`;
    }
  }
  return null;
}

// --- GitHub ------------------------------------------------------------------

/** Top-level API areas where every write is refused (account keys, apps, org and team administration, gists). */
const GITHUB_NO_WRITES = new Set(["user", "users", "authorizations", "applications", "app", "app-manifests", "installation", "orgs", "teams", "enterprises", "admin", "gists"]);

/** Repository sub-resources where every write is refused. */
const GITHUB_REPO_NO_WRITES = new Set([
  "keys",
  "collaborators",
  "invitations",
  "hooks",
  "transfer",
  "forks",
  "environments",
  "rulesets",
  "pages",
  "dependabot",
  "codespaces",
  "interaction-limits",
  "vulnerability-alerts",
  "automated-security-fixes",
  "private-vulnerability-reporting",
  "security-advisories",
  "autolinks",
  "import",
]);

const GITHUB_ACTIONS_NO_WRITES = new Set(["secrets", "variables", "runners", "runner-groups", "permissions", "oidc", "organization-secrets", "organization-variables"]);

/** GraphQL mutations an agent doing repository work needs (issues, pull requests, reviews, branches, commits). */
const GITHUB_MUTATIONS = new Set([
  "addComment",
  "updateIssueComment",
  "deleteIssueComment",
  "createIssue",
  "updateIssue",
  "closeIssue",
  "reopenIssue",
  "addLabelsToLabelable",
  "removeLabelsFromLabelable",
  "addAssigneesToAssignable",
  "removeAssigneesFromAssignable",
  "createPullRequest",
  "updatePullRequest",
  "closePullRequest",
  "reopenPullRequest",
  "mergePullRequest",
  "markPullRequestReadyForReview",
  "convertPullRequestToDraft",
  "requestReviews",
  "addPullRequestReview",
  "submitPullRequestReview",
  "deletePullRequestReview",
  "addPullRequestReviewComment",
  "addPullRequestReviewThread",
  "resolveReviewThread",
  "unresolveReviewThread",
  "updatePullRequestBranch",
  "enablePullRequestAutoMerge",
  "disablePullRequestAutoMerge",
  "addReaction",
  "removeReaction",
  "createRef",
  "updateRef",
  "deleteRef",
  "createCommitOnBranch",
]);

const isDotGithub = (p: unknown) => typeof p === "string" && p.replace(/^\/+/, "").split("/")[0].toLowerCase() === ".github";

const WORKFLOW_REASON = "the relay doesn't forward writes under .github/ (workflows can read the repository's secrets)";

/** Why the relay refuses this GitHub request, or null to forward it. `segments` are decoded path segments. */
export function githubDenial(method: string, rawSegments: string[], body: Uint8Array | null): string | null {
  if (method === "GET" || method === "HEAD") return null;
  const path = `/${rawSegments.join("/")}`;
  const refuse = `the relay doesn't forward ${method} ${path} to GitHub: it could create credentials or change who has access`;
  const segments = rawSegments.map((s) => s.toLowerCase());
  const [area] = segments;

  if (area === "graphql") {
    const denial = graphqlDenial("GitHub", body, (f) => GITHUB_MUTATIONS.has(f));
    if (denial) return denial;
    // createCommitOnBranch carries file paths in its input; refuse any that touch .github/.
    const text = body ? new TextDecoder().decode(body) : "";
    if (/createCommitOnBranch/.test(text) && /\.github\//i.test(text)) return WORKFLOW_REASON;
    return null;
  }
  if (GITHUB_NO_WRITES.has(area)) return refuse;
  // A repository is /repos/{owner}/{repo}/... or, by id, /repositories/{id}/...
  const rest = area === "repos" ? segments.slice(3) : area === "repositories" ? segments.slice(2) : null;
  if (rest) {
    if (rest.length === 0) return refuse; // repository settings, visibility, delete
    const [sub] = rest;
    if (GITHUB_REPO_NO_WRITES.has(sub)) return refuse;
    if (sub === "actions" && GITHUB_ACTIONS_NO_WRITES.has(rest[1])) return refuse;
    if ((sub === "branches" || sub === "tags") && rest.includes("protection")) return refuse;
    if (sub === "contents" && isDotGithub(rest.slice(1).join("/"))) return WORKFLOW_REASON;
    if (sub === "git" && rest[1] === "trees" && body) {
      try {
        const tree = (JSON.parse(new TextDecoder().decode(body)) as { tree?: { path?: unknown }[] }).tree;
        if (Array.isArray(tree) && tree.some((e) => isDotGithub(e?.path))) return WORKFLOW_REASON;
      } catch {
        // Not JSON: GitHub rejects it.
      }
    }
  }
  return null;
}

// --- Railway -----------------------------------------------------------------

/** Mutation names that create tokens, invite people or change membership, logins or integrations. */
const RAILWAY_DENY = /token|invit|member|team|user|workspace|webhook|login|session|auth|integration|transfer|twofactor|recovery|passkey|referral|billing|customer|leave/i;

/** Why the relay refuses this Railway request, or null to forward it. */
export function railwayDenial(method: string, segments: string[], body: Uint8Array | null): string | null {
  const path = `/${segments.join("/")}`;
  if (path !== "/graphql/v2") return `the relay only forwards Railway's GraphQL API (POST /graphql/v2), not ${method} ${path}`;
  if (method !== "POST") return `Railway GraphQL requests must be POST`;
  return graphqlDenial("Railway", body, (f) => !RAILWAY_DENY.test(f));
}

// --- Other pass-through providers ------------------------------------------------

type PassRule = {
  /** Refused for every method (e.g. reads that reveal secrets, or RPC-style APIs where GET can write). */
  any?: RegExp;
  /** Refused for writes (anything but GET and HEAD). */
  writes?: RegExp;
};

/** Tested against each decoded path segment, lower-cased. */
const PASS_RULES: Partial<Record<ProviderId, PassRule>> = {
  // Environment variables hold secrets (GET ?decrypt=true returns them); tokens, teams, webhooks and integrations outlive the name.
  vercel: {
    any: /^env$/,
    writes: /^(user|tokens?|teams|members|invites?|integrations|webhooks|access-groups|secrets|log-drains|drains|deploy-hooks|protection-bypass|oauth|edge-config-tokens)$/,
  },
  // Slack methods are one segment ("auth.revoke") and accept GET, so these are refused for every method.
  slack: { any: /^(auth\.revoke|apps\.|admin\.|oauth\.|openid\.|team\.|usergroups\.|workflows\.|migration\.)/ },
  stripe: {
    any: /^secrets$/,
    writes: /^(webhook_endpoints|apps|account_links|accounts|login_links|account_sessions|ephemeral_keys|api_keys|oauth)$/,
  },
  hubspot: { any: /^oauth$/, writes: /^(webhooks|settings|users|integrations|extensions|account-info|oauth)$/ },
  mailchimp: { writes: /^(webhooks|authorized-apps|account-exports|verified-domains)$/ },
  notion: { any: /^oauth$/ },
  canva: { any: /^oauth$/ },
};

/** Linear mutations an agent doing issue work needs; everything else (API keys, webhooks, members, integrations) is refused. */
const LINEAR_ALLOW = /^(issue|comment|attachment|reaction|project|document|cycle|favorite|notification)/;
const LINEAR_DENY = /import|integration|webhook|apikey|oauth|token|invite|member|user|organization|auth|session|passkey|team/i;

/** Why the relay refuses this Linear request, or null to forward it. */
export function linearDenial(method: string, segments: string[], body: Uint8Array | null): string | null {
  const path = `/${segments.join("/")}`;
  if (path !== "/graphql") return `the relay only forwards Linear's GraphQL API (POST /graphql), not ${method} ${path}`;
  if (method !== "POST") return `Linear GraphQL requests must be POST`;
  return graphqlDenial("Linear", body, (f) => LINEAR_ALLOW.test(f) && !LINEAR_DENY.test(f));
}

/** Why the relay refuses this request to a pass-through provider, or null to forward it. */
export function routeDenial(provider: ProviderId, method: string, segments: string[], body: Uint8Array | null): string | null {
  if (provider === "github") return githubDenial(method, segments, body);
  if (provider === "railway") return railwayDenial(method, segments, body);
  if (provider === "linear") return linearDenial(method, segments, body);
  const rule = PASS_RULES[provider];
  if (!rule) return null;
  const lower = segments.map((seg) => seg.toLowerCase());
  const write = method !== "GET" && method !== "HEAD";
  const hit = lower.find((seg) => rule.any?.test(seg) || (write && rule.writes?.test(seg)));
  if (!hit) return null;
  const label = catalogEntry(provider).label;
  return `the relay doesn't forward ${method} /${segments.join("/")} to ${label}: it could reveal secrets, create credentials or webhooks, change who has access, or revoke the relay's key`;
}
