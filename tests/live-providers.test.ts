import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { CredentialKeyView } from "../components/live/providers/api";
import {
  bytesToHex,
  canManage,
  canonicalJson,
  checkBinding,
  customPill,
  formatUpdated,
  groupCatalog,
  isBuiltIn,
  isKeyless,
  keysFor,
  markFor,
  messageFor,
  parseQuote,
  fieldValue,
  planChanges,
  secretDisplay,
  sha256Hex,
  sharedWith,
  sourceLabel,
  statusPill,
  upstreamHost,
} from "../components/live/providers/logic";
import { CATALOG, catalogEntry } from "../lib/relay/catalog";
import { providerMarks } from "../lib/provider-marks";
import { iconPaths } from "../lib/icons";

const key = (over: Partial<CredentialKeyView>): CredentialKeyView => ({
  env: "OPENAI_API_KEY",
  label: "API key",
  apis: ["codex", "openai-images"],
  secret: true,
  kind: "key",
  placeholder: "",
  set: true,
  source: "store",
  updatedAt: 1_790_000_000,
  hint: "sk-p••••••••3f2a",
  ...over,
});

test("status pill: codex live, others routed, mock is built in", () => {
  assert.deepEqual(statusPill(catalogEntry("codex"), true), { text: "Live · routed", tone: "live" });
  assert.deepEqual(statusPill(catalogEntry("claude"), true), { text: "Routed · key set", tone: "ok" });
  assert.deepEqual(statusPill(catalogEntry("github"), false), { text: "Routed · no key", tone: "idle" });
  assert.equal(statusPill(catalogEntry("slack"), undefined).text, "Checking…");
  assert.equal(statusPill(catalogEntry("mock"), false).tone, "builtin");
  assert.equal(statusPill(catalogEntry("mock"), false).text, "Built in · no key needed");
  // Weather (OpenWeatherMap) has a key like the others.
  const weather = catalogEntry("weather");
  assert.deepEqual(statusPill(weather, true), { text: "Routed · key set", tone: "ok" });
  assert.deepEqual(statusPill(weather, false), { text: "Routed · no key", tone: "idle" });
  assert.equal(statusPill(weather, undefined).text, "Checking…");
  // A public API without any key would still read as routed.
  assert.deepEqual(statusPill({ id: "public", keyEnv: null, upstream: "https://api.example.com" }, undefined), { text: "No key needed · routed", tone: "ok" });
  assert.equal(customPill(true).text, "Stored · not routed");
  assert.equal(customPill(false).text, "No credentials");
});

test("every catalog API has a brand mark or stroke icon", () => {
  for (const entry of CATALOG) {
    const mark = markFor(entry.id);
    assert.ok(providerMarks[mark] || iconPaths[mark], `${entry.id} → ${mark}`);
  }
  assert.equal(markFor("claude"), "anthropic");
  assert.equal(markFor("openai-images"), "openai");
  // Weather has no brand mark: its own sun-and-cloud stroke icon.
  assert.equal(markFor("weather"), "weather");
  assert.ok(iconPaths.weather && !providerMarks.weather);
});

test("keyless APIs: the test API is built in; weather has a key, so it is neither", () => {
  const byId = (id: string) => CATALOG.find((e) => e.id === id)!;
  assert.equal(isBuiltIn(byId("mock")), true);
  assert.equal(isKeyless(byId("mock")), false);
  assert.equal(isKeyless(byId("weather")), false);
  assert.equal(isBuiltIn(byId("weather")), false);
  assert.equal(isKeyless(byId("github")), false);
  assert.equal(isKeyless({ keyEnv: null, upstream: "https://api.example.com" }), true);
  assert.equal(upstreamHost(byId("weather").upstream), "api.openweathermap.org");
  assert.equal(upstreamHost(null), "");
  assert.equal(upstreamHost("not a url"), "not a url");
});

test("catalog groups keep category order and cover every API", () => {
  const groups = groupCatalog();
  assert.deepEqual(groups.map((g) => g.category), ["ai", "dev", "marketing", "business", "data", "blockchain", "test"]);
  assert.deepEqual(
    groups.find((g) => g.category === "data")!.entries.map((e) => [e.id, e.category]),
    [["weather", "data"]],
  );
  assert.equal(groups.find((g) => g.category === "data")!.label, "Data");
  assert.equal(groups.reduce((n, g) => n + g.entries.length, 0), CATALOG.length);
});

test("shared keys and key rows per API", () => {
  assert.deepEqual(sharedWith(catalogEntry("codex")), ["OpenAI Images"]);
  assert.deepEqual(sharedWith(catalogEntry("mock")), []);
  const rows = keysFor(catalogEntry("mailchimp"), [
    key({ env: "RELAY_UPSTREAM_MAILCHIMP", apis: ["mailchimp"], secret: false, kind: "upstream", value: "https://us21.api.mailchimp.com", hint: null }),
    key({ env: "MAILCHIMP_TOKEN", apis: ["mailchimp"] }),
    key({ env: "OPENAI_API_KEY" }),
  ]);
  assert.deepEqual(rows.map((r) => r.env), ["MAILCHIMP_TOKEN", "RELAY_UPSTREAM_MAILCHIMP"]);
  // No server rows yet: the catalog's key env stands in, unset.
  const fallback = keysFor(catalogEntry("stripe"), undefined);
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].env, "STRIPE_SECRET_KEY");
  assert.equal(fallback[0].set, false);
  // Weather's card edits OPENWEATHER_API_KEY like any other key, shared with nothing.
  assert.deepEqual(sharedWith(catalogEntry("weather")), []);
  assert.deepEqual(keysFor(catalogEntry("weather"), undefined).map((r) => [r.env, r.secret, r.set]), [["OPENWEATHER_API_KEY", true, false]]);
  const weatherRows = keysFor(catalogEntry("weather"), [key({ env: "OPENWEATHER_API_KEY", apis: ["weather"], hint: "••••••••cdef" }), key({ env: "OPENAI_API_KEY" })]);
  assert.deepEqual(weatherRows.map((r) => r.env), ["OPENWEATHER_API_KEY"]);
  assert.equal(secretDisplay(weatherRows[0], true), "••••••••cdef");
});

test("redaction display never invents a secret and hides hints from anonymous viewers", () => {
  assert.equal(secretDisplay(key({}), true), "sk-p••••••••3f2a");
  assert.equal(secretDisplay(key({}), false), "Set");
  assert.equal(secretDisplay(key({ set: false, hint: null }), true), "Not set");
  assert.equal(secretDisplay(key({ hint: null }), true), "Set");
  const plain = key({ secret: false, value: "https://us21.api.mailchimp.com", hint: null });
  assert.equal(secretDisplay(plain, true), "https://us21.api.mailchimp.com");
  assert.equal(secretDisplay(plain, false), "Set");
  assert.equal(canManage(undefined), false);
  assert.equal(canManage({ owner: null, admin: false }), false);
  assert.equal(canManage({ owner: null, admin: true }), true);
  assert.equal(canManage({ owner: { address: "0x1", expiresAt: 1 }, admin: false }), true);
});

test("edit plan: empty keeps, Clear deletes, plain settings diff", () => {
  const secret = key({});
  const unset = key({ env: "GEMINI_API_KEY", set: false, hint: null });
  const plain = key({ env: "RELAY_UPSTREAM_MAILCHIMP", secret: false, kind: "upstream", value: "https://us1.api.mailchimp.com" });
  // Untouched fields send nothing, even when the plain setting's value arrived after the dialog opened.
  assert.deepEqual(planChanges([secret, unset, plain], {}, new Set()), []);
  // Emptying a plain setting on purpose clears it.
  assert.deepEqual(planChanges([secret, unset, plain], { RELAY_UPSTREAM_MAILCHIMP: " " }, new Set()), [{ env: "RELAY_UPSTREAM_MAILCHIMP", action: "delete" }]);
  // Pasting only the Mailchimp key leaves the data-center URL alone.
  const mailchimpKey = key({ env: "MAILCHIMP_API_KEY", set: false, hint: null });
  assert.deepEqual(planChanges([mailchimpKey, plain], { MAILCHIMP_API_KEY: "abc-us21" }, new Set()), [
    { env: "MAILCHIMP_API_KEY", action: "put", value: "abc-us21" },
  ]);
  assert.equal(fieldValue(plain, {}), "https://us1.api.mailchimp.com");
  assert.equal(fieldValue(plain, { RELAY_UPSTREAM_MAILCHIMP: "" }), "");
  assert.equal(fieldValue(secret, {}), "");
  assert.deepEqual(planChanges([secret, plain], { RELAY_UPSTREAM_MAILCHIMP: "https://us1.api.mailchimp.com" }, new Set()), []);
  assert.deepEqual(planChanges([secret, unset], { OPENAI_API_KEY: "  sk-new  ", GEMINI_API_KEY: "" }, new Set()), [
    { env: "OPENAI_API_KEY", action: "put", value: "sk-new" },
  ]);
  assert.deepEqual(planChanges([secret], { OPENAI_API_KEY: "sk-new" }, new Set(["OPENAI_API_KEY"])), [{ env: "OPENAI_API_KEY", action: "delete" }]);
  // Clearing something that isn't set sends nothing.
  assert.deepEqual(planChanges([unset], {}, new Set(["GEMINI_API_KEY"])), []);
  assert.deepEqual(planChanges([plain], { RELAY_UPSTREAM_MAILCHIMP: "https://us21.api.mailchimp.com" }, new Set()), [
    { env: "RELAY_UPSTREAM_MAILCHIMP", action: "put", value: "https://us21.api.mailchimp.com" },
  ]);
});

test("formatting helpers are deterministic", () => {
  assert.equal(formatUpdated(null), "Never");
  assert.equal(formatUpdated(1_790_000_000), "2026-09-21 14:13 UTC");
  assert.equal(formatUpdated(1_790_000_000_000), "2026-09-21 14:13 UTC");
  assert.equal(messageFor("Sign in\nAddress: {address}\nNonce: 1", "0xAbC"), "Sign in\nAddress: 0xAbC\nNonce: 1");
  assert.equal(sourceLabel("simulator"), "dstack simulator");
  assert.equal(sourceLabel("tee"), "TDX hardware");
});

test("canonical JSON sorts keys at every level and drops undefined", () => {
  const a = { v: 1, relay: "http://x", services: [{ id: "codex", configured: true }], nonce: null, extra: undefined };
  const b = { services: [{ configured: true, id: "codex" }], nonce: null, relay: "http://x", v: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(a), '{"nonce":null,"relay":"http://x","services":[{"configured":true,"id":"codex"}],"v":1}');
  assert.equal(canonicalJson("é\n"), JSON.stringify("é\n"));
});

test("sha256Hex matches Node crypto (no WebCrypto needed)", () => {
  const text = canonicalJson({ v: 1, root: "acme.eth" });
  assert.equal(sha256Hex(text), createHash("sha256").update(text).digest("hex"));
});

/** A synthetic TDX v4 quote: 48-byte header + 584-byte body (+ a fake signature tail). */
function fakeQuote(reportData: Uint8Array): string {
  const bytes = new Uint8Array(48 + 584 + 16);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 4, true);
  view.setUint16(2, 2, true);
  view.setUint32(4, 0x81, true);
  bytes.fill(0x11, 48 + 136, 48 + 184); // MRTD
  bytes.fill(0x22, 48 + 328, 48 + 376); // RTMR0
  bytes.fill(0x55, 48 + 472, 48 + 520); // RTMR3
  bytes.set(reportData, 48 + 520);
  return `0x${bytesToHex(bytes)}`;
}

test("TDX quote parsing reads type, measurements and report data", () => {
  const rd = new Uint8Array(64).fill(0xab);
  const parsed = parseQuote(fakeQuote(rd));
  assert.ok(parsed);
  assert.equal(parsed.version, 4);
  assert.equal(parsed.teeType, "TDX");
  assert.equal(parsed.measurements?.mrtd, "11".repeat(48));
  assert.equal(parsed.measurements?.rtmr0, "22".repeat(48));
  assert.equal(parsed.measurements?.rtmr3, "55".repeat(48));
  assert.equal(parsed.measurements?.reportData, "ab".repeat(64));
  assert.equal(parseQuote("zz"), null);
  assert.equal(parseQuote("0x00"), null);
  assert.equal(parseQuote(null), null);
});

test("statement binding: sha256(canonical statement) is the quote's report data prefix", async () => {
  const statement = {
    v: 1,
    relay: "http://127.0.0.1:3000/api/relay",
    root: "acme.eth",
    rootOwner: "0x0000000000000000000000000000000000000001",
    services: [
      { id: "codex", configured: true },
      { id: "claude", configured: false },
    ],
    build: null,
    issuedAt: 1_790_000_000,
    nonce: null,
  };
  const hash = createHash("sha256").update(canonicalJson(statement)).digest();
  const rd = new Uint8Array(64);
  rd.set(hash, 0);
  const quote = fakeQuote(rd);

  const ok = await checkBinding({ statement, statementHash: hash.toString("hex"), reportData: bytesToHex(rd), quote });
  assert.equal(ok.bound, true);
  assert.equal(ok.reportDataFrom, "quote");
  assert.equal(ok.hashMatchesServer, true);

  // A tampered statement no longer matches the quote.
  const bad = await checkBinding({ statement: { ...statement, root: "evil.eth" }, statementHash: hash.toString("hex"), quote });
  assert.equal(bad.bound, false);
  assert.equal(bad.hashMatchesServer, false);

  // Without a parseable quote, the relay's own reportData proves nothing: never "bound".
  const fallback = checkBinding({ statement, reportData: `0x${bytesToHex(rd)}`, quote: "0x" });
  assert.equal(fallback.bound, false);
  assert.equal(fallback.reportDataFrom, "server");
  assert.equal(fallback.quoteReportData, bytesToHex(rd));
  assert.equal(fallback.hashMatchesServer, null);
  // Nor do measurements the relay parsed for us.
  const claimed = checkBinding({ statement, quote: "0x", measurements: { mrtd: "", rtmr0: "", rtmr1: "", rtmr2: "", rtmr3: "", reportData: bytesToHex(rd) } });
  assert.equal(claimed.bound, false);
  assert.equal(claimed.reportDataFrom, "server");
});
