import assert from "node:assert/strict";
import { test } from "node:test";

import { parseExtraRoutes } from "./config";
import { MIN_OUTPUT_TOKENS, planCall } from "./plan";
import { estimateInputTokens } from "./pricing";
import { githubDenial, graphqlOperations, routeDenial, routeFor, pathSegments, railwayDenial } from "./routes";

const enc = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));

test("pathSegments decodes segments and drops a trailing slash", () => {
  assert.deepEqual(pathSegments("/v1/models/"), ["v1", "models"]);
  assert.deepEqual(pathSegments("/repos/a/b/contents/%2Egithub/workflows/x.yml"), ["repos", "a", "b", "contents", ".github", "workflows", "x.yml"]);
  assert.deepEqual(pathSegments(""), []);
});

test("routeFor: only known endpoints, HEAD like GET, extra routes from config", () => {
  assert.deepEqual(routeFor("claude", "POST", ["v1", "messages"]), { kind: "generate", api: "anthropic-messages" });
  assert.deepEqual(routeFor("claude", "HEAD", ["v1", "models", "claude-opus-5"]), { kind: "free", api: null });
  assert.equal(routeFor("claude", "GET", ["v1", "messages"]), null);
  assert.equal(routeFor("claude", "POST", ["v1", "messages", "batches"]), null);
  assert.deepEqual(routeFor("codex", "POST", ["v1", "embeddings"]), { kind: "embed", api: "openai-embeddings" });
  assert.equal(routeFor("codex", "GET", ["v1", "responses", "resp_1"]), null);
  const extra = parseExtraRoutes("codex:POST /v1/responses/compact, claude:GET /v1/files/*=free, bogus, mock:GET /x, claude:TRACE /x");
  assert.equal(extra.length, 2);
  assert.deepEqual(routeFor("codex", "POST", ["v1", "responses", "compact"], extra), { kind: "generate", api: "custom" });
  assert.deepEqual(routeFor("claude", "GET", ["v1", "files", "file_1"], extra), { kind: "free", api: null });
});

test("graphqlOperations: operation types, aliases, arguments, directives, fragments, comments and strings", () => {
  assert.deepEqual(graphqlOperations("{ viewer { login } }"), [{ type: "query", fields: ["viewer"], spreads: false }]);
  assert.deepEqual(
    graphqlOperations(`
      # a comment with mutation { evil }
      mutation Make($i: Input! = {a: "}"}) @dir(x: 1) {
        pr: createPullRequest(input: $i) @include(if: true) { pullRequest { id } }
        addComment(input: {body: """mutation { addDeployKey }"""}) { clientMutationId }
      }
      fragment F on User { login }
      query Q { viewer { ...F } }
    `),
    [
      { type: "mutation", fields: ["createPullRequest", "addComment"], spreads: false },
      { type: "query", fields: ["viewer"], spreads: false },
    ],
  );
  assert.equal(graphqlOperations("mutation { ...Evil }")?.[0].spreads, true);
  assert.equal(graphqlOperations("mutation { ... on Mutation { addDeployKey } }")?.[0].spreads, true);
  assert.equal(graphqlOperations("mutation { unterminated"), null);
  assert.equal(graphqlOperations('mutation { a(x: "open) }'), null);
  assert.equal(graphqlOperations("type Query { x: Int }"), null);
});

test("githubDenial: writes that create credentials, change access or touch .github/ are refused", () => {
  const deny = (method: string, p: string, body?: unknown) => githubDenial(method, pathSegments(p), body === undefined ? null : enc(body));
  assert.equal(deny("GET", "/user/keys"), null, "reads pass");
  assert.equal(deny("POST", "/repos/a/b/pulls", { title: "x" }), null);
  assert.equal(deny("PUT", "/repos/a/b/contents/src/index.ts", {}), null);
  assert.equal(deny("POST", "/repos/a/b/git/trees", { tree: [{ path: "src/a.ts" }] }), null);
  assert.equal(deny("POST", "/repos/a/b/actions/workflows/ci.yml/dispatches", { ref: "main" }), null);
  for (const [m, p] of [
    ["POST", "/user/keys"],
    ["POST", "/user/gpg_keys"],
    ["POST", "/repos/a/b/keys"],
    ["PUT", "/repos/a/b/collaborators/x"],
    ["POST", "/repos/a/b/hooks"],
    ["POST", "/repos/a/b/forks"],
    ["PUT", "/repos/a/b/actions/secrets/X"],
    ["POST", "/repos/a/b/actions/runners/registration-token"],
    ["DELETE", "/repos/a/b/branches/main/protection"],
    ["POST", "/orgs/a/invitations"],
    ["PUT", "/teams/1/memberships/x"],
    ["DELETE", "/repos/a/b"],
    ["POST", "/gists"],
    ["POST", "/repositories/123/keys"],
    ["PATCH", "/repositories/123"],
    ["POST", "/repos/a/b/KEYS"],
    ["POST", "/User/Keys"],
  ]) {
    assert.match(deny(m, p) ?? "", /credentials or change who has access/, `${m} ${p}`);
  }
  assert.match(deny("PUT", "/repos/a/b/contents/.GitHub/workflows/x.yml", {}) ?? "", /\.github/);
  assert.match(deny("PUT", "/repositories/123/contents/.github/workflows/x.yml", {}) ?? "", /\.github/);
  assert.equal(deny("POST", "/repositories/123/issues", { title: "x" }), null);
  assert.match(deny("POST", "/repos/a/b/git/trees", { tree: [{ path: ".github", type: "tree", sha: "abc" }] }) ?? "", /\.github/);
  const commit = { query: "mutation($i: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $i) { commit { oid } } }", variables: { i: { fileChanges: { additions: [{ path: ".github/workflows/x.yml" }] } } } };
  assert.match(deny("POST", "/graphql", commit) ?? "", /\.github/);
  assert.match(deny("POST", "/graphql", { query: "mutation { updateRepository(input: {}) { clientMutationId } }" }) ?? "", /updateRepository/);
  assert.match(deny("POST", "/graphql", [{ query: "{ viewer { login } }" }, { query: "mutation { addDeployKey }" }]) ?? "", /addDeployKey/);
  assert.equal(deny("POST", "/graphql", [{ query: "{ viewer { login } }" }]), null);
  assert.match(deny("POST", "/graphql", "not json") ?? "", /couldn't read/);
});

test("railwayDenial: only POST /graphql/v2, no token, member or login mutations", () => {
  const deny = (method: string, p: string, body?: unknown) => railwayDenial(method, pathSegments(p), body === undefined ? null : enc(body));
  assert.equal(deny("POST", "/graphql/v2", { query: "{ projects { edges { node { id } } } }" }), null);
  assert.equal(deny("POST", "/graphql/v2", { query: 'mutation { variableUpsert(input: {}) serviceInstanceRedeploy(serviceId: "s", environmentId: "e") }' }), null);
  assert.match(deny("POST", "/graphql/v2", { query: "mutation { apiTokenCreate(input: {}) }" }) ?? "", /apiTokenCreate/);
  assert.match(deny("POST", "/graphql/v2", { query: "mutation { projectInvitationCreate(input: {}) { id } }" }) ?? "", /projectInvitationCreate/);
  assert.match(deny("POST", "/graphql/v2", { query: "subscription { deploymentLogs }" }) ?? "", /subscriptions/);
  assert.match(deny("GET", "/graphql/v2") ?? "", /POST/);
  assert.match(deny("POST", "/v1/anything", {}) ?? "", /only forwards/);
});

test("routeDenial: pass-through APIs refuse credentials, webhooks, access changes and revoking the relay's key", () => {
  const deny = (provider: Parameters<typeof routeDenial>[0], method: string, p: string, body?: unknown) =>
    routeDenial(provider, method, pathSegments(p), body === undefined ? null : enc(body));
  // Refused
  assert.match(deny("vercel", "POST", "/v3/user/tokens") ?? "", /doesn't forward POST \/v3\/user\/tokens to Vercel/);
  assert.ok(deny("vercel", "GET", "/v10/projects/p/env"), "env values are secrets, even on GET");
  assert.ok(deny("vercel", "POST", "/v1/integrations/configuration"));
  assert.ok(deny("stripe", "POST", "/v1/webhook_endpoints"));
  assert.ok(deny("stripe", "GET", "/v1/apps/secrets/find"));
  assert.ok(deny("slack", "POST", "/auth.revoke"));
  assert.ok(deny("slack", "GET", "/auth.revoke"), "Slack methods accept GET");
  assert.ok(deny("slack", "POST", "/admin.users.invite"));
  assert.ok(deny("hubspot", "POST", "/webhooks/v3/1/subscriptions"));
  assert.ok(deny("hubspot", "POST", "/settings/v3/users"));
  assert.ok(deny("mailchimp", "POST", "/3.0/lists/abc/webhooks"));
  assert.ok(deny("notion", "POST", "/v1/oauth/token"));
  assert.ok(deny("canva", "POST", "/rest/v1/oauth/revoke"));
  assert.match(deny("linear", "POST", "/graphql", { query: "mutation { apiKeyCreate(input: {}) { success } }" }) ?? "", /apiKeyCreate/);
  assert.match(deny("linear", "POST", "/graphql", { query: "mutation { webhookCreate(input: {}) { success } }" }) ?? "", /webhookCreate/);
  assert.match(deny("linear", "POST", "/graphql", { query: "mutation { issueImportCreateGithub(input: {}) { success } }" }) ?? "", /issueImportCreateGithub/);
  assert.match(deny("linear", "GET", "/oauth/authorize") ?? "", /only forwards/);
  // Forwarded
  assert.equal(deny("vercel", "GET", "/v6/deployments"), null);
  assert.equal(deny("vercel", "POST", "/v13/deployments", {}), null);
  assert.equal(deny("stripe", "GET", "/v1/customers"), null);
  assert.equal(deny("stripe", "POST", "/v1/customers", {}), null);
  assert.equal(deny("slack", "POST", "/chat.postMessage", {}), null);
  assert.equal(deny("slack", "POST", "/auth.test"), null);
  assert.equal(deny("hubspot", "POST", "/crm/v3/objects/contacts", {}), null);
  assert.equal(deny("mailchimp", "POST", "/3.0/lists/abc/members", {}), null);
  assert.equal(deny("notion", "POST", "/v1/pages", {}), null);
  assert.equal(deny("canva", "POST", "/rest/v1/designs", {}), null);
  assert.equal(deny("linear", "POST", "/graphql", { query: "{ issues { nodes { id } } }" }), null);
  assert.equal(deny("linear", "POST", "/graphql", { query: "mutation { issueCreate(input: {}) { success } commentCreate(input: {}) { success } }" }), null);
  assert.equal(deny("mock", "POST", "/v1/anything", {}), null);
  // GitHub and Railway keep their own rules.
  assert.ok(deny("github", "POST", "/repos/a/b/keys", {}));
  assert.ok(deny("railway", "GET", "/graphql/v2"));
});

test("estimateInputTokens: text at ~3 bytes per token, base64 media at ~40 characters per token", () => {
  const text = { messages: [{ role: "user", content: "hello world ".repeat(100) }] };
  const bytes = enc(text).byteLength;
  assert.equal(estimateInputTokens(text, bytes), Math.ceil(bytes / 3));
  const data = "A".repeat(40_000);
  const image = { messages: [{ content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }] }] };
  const b = enc(image).byteLength;
  assert.equal(estimateInputTokens(image, b), Math.ceil((b - data.length) / 3) + 1000);
  const url = `data:image/png;base64,${data}`;
  const openai = { input: [{ type: "input_image", image_url: url }] };
  assert.equal(estimateInputTokens(openai, enc(openai).byteLength), Math.ceil((enc(openai).byteLength - url.length) / 3) + Math.ceil(url.length / 40));
  // A long run of letters that isn't in a media field is text.
  const plain = { messages: [{ content: "x".repeat(3000) }] };
  assert.equal(estimateInputTokens(plain, enc(plain).byteLength), Math.ceil(enc(plain).byteLength / 3));
});

const plan = (provider: "claude" | "codex", api: Parameters<typeof planCall>[0]["api"], body: unknown, available: number | null, kind: "generate" | "embed" | "free" = "generate") =>
  planCall({ provider, kind, api, body: body === null ? null : enc(body), available, maxOutputTokens: 32_000, codexPrices: {} });

test("planCall: worst case = estimated input + output limit at the model's price", () => {
  const body = { model: "claude-sonnet-4-6", max_tokens: 1000, messages: [] };
  const r = plan("claude", "anthropic-messages", body, 10);
  assert.ok(r.ok);
  const input = Math.ceil(enc(body).byteLength / 3);
  assert.equal(r.plan.inputTokens, input);
  assert.ok(Math.abs(r.plan.worstUsd - (input * 3 + 1000 * 15) / 1e6) < 1e-12);
  assert.equal(r.plan.injectedLimit, null);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(r.plan.body!)), body, "sent unchanged");
  // Cache writes (1h) double the input price; fast mode doubles everything.
  const cached = plan("claude", "anthropic-messages", { ...body, system: [{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "1h" } }] }, 10);
  const fast = plan("claude", "anthropic-messages", { ...body, speed: "fast" }, 10);
  assert.ok(cached.ok && fast.ok);
  assert.ok(cached.plan.floorUsd > r.plan.floorUsd * 1.9);
  assert.ok(fast.plan.worstUsd > r.plan.worstUsd * 1.9);
});

test("planCall: a client limit that doesn't fit is refused; a missing limit is set to fit", () => {
  const refused = plan("claude", "anthropic-messages", { model: "claude-opus-5", max_tokens: 64_000 }, 0.5);
  assert.ok(!refused.ok);
  assert.equal(refused.status, 403);
  assert.match(refused.reason, /lower max_tokens/);

  const fitted = plan("codex", "openai-responses", { model: "gpt-5", input: "hi" }, 0.1);
  assert.ok(fitted.ok);
  const sent = JSON.parse(new TextDecoder().decode(fitted.plan.body!));
  assert.equal(sent.max_output_tokens, fitted.plan.injectedLimit);
  assert.ok(fitted.plan.worstUsd <= 0.1 + 1e-12);
  assert.equal(fitted.plan.injectedLimit, Math.floor((0.1 - fitted.plan.floorUsd) / 10e-6)); // estimated gpt-5 output: $10 / MTok

  const uncapped = plan("codex", "openai-responses", { model: "gpt-5", input: "hi" }, null);
  assert.ok(uncapped.ok && uncapped.plan.injectedLimit === 32_000);

  const broke = plan("codex", "openai-responses", { model: "gpt-5", input: "hi" }, (MIN_OUTPUT_TOKENS - 1) * 10e-6);
  assert.ok(!broke.ok);
  assert.match(broke.reason, /not enough budget/);
});

test("planCall: chat streams ask for usage; n multiplies the output; legacy max_tokens counts as the limit", () => {
  const r = plan("codex", "openai-chat", { model: "gpt-5", stream: true, n: 3, max_tokens: 100, stream_options: { foo: 1 }, messages: [] }, null);
  assert.ok(r.ok);
  const sent = JSON.parse(new TextDecoder().decode(r.plan.body!));
  assert.deepEqual(sent.stream_options, { foo: 1, include_usage: true });
  assert.equal(sent.max_completion_tokens, undefined, "the client's max_tokens is kept");
  assert.equal(r.plan.outputTokens, 300);
});

test("planCall: embeddings are input only, free routes cost nothing, non-JSON bodies are refused", () => {
  const e = plan("codex", "openai-embeddings", { model: "text-embedding-3-small", input: "hello" }, 1, "embed");
  assert.ok(e.ok && e.plan.worstUsd === e.plan.floorUsd && e.plan.outputTokens === 0);
  const f = plan("claude", null, null, 0, "free");
  assert.ok(f.ok && f.plan.worstUsd === 0);
  const bad = planCall({ provider: "claude", kind: "generate", api: "anthropic-messages", body: enc("not json"), available: 1, maxOutputTokens: 32_000, codexPrices: {} });
  assert.ok(!bad.ok && bad.status === 400);
});
