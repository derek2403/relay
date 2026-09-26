import assert from "node:assert/strict";
import test from "node:test";

import { authScript, conflictingTables, withRelayCodexConfig, withoutRelayCodexConfig } from "../scripts/lib/codex-config";

const opts = { agent: "codex.derek.cloudops.dev.sodalabs.eth", relayUrl: "https://relay.derek2403.win/", authCommand: "/Users/d/.relay/codex-auth", model: "gpt-5.3-codex" };
const existing = 'model = "gpt-6-astra"\napproval_policy = "never"\n\n[features]\nfoo = true\n\n[projects."/Users/d/x"]\ntrust_level = "trusted"\n';

test("points plain codex at the relay provider, setting the user's model aside", () => {
  const { text } = withRelayCodexConfig(existing, opts);
  assert.ok(text.startsWith('model_provider = "relay" # relay login\nmodel = "gpt-5.3-codex" # relay login\n'));
  assert.ok(text.includes('# relay login saved: model = "gpt-6-astra"'), "the user's model is kept as a comment");
  assert.equal(text.split(/^model = /m).length, 2, "only one active model key");
  assert.ok(text.includes('approval_policy = "never"') && text.includes("[features]") && text.includes('[projects."/Users/d/x"]'));
  assert.ok(text.includes('base_url = "https://relay.derek2403.win/api/relay/codex/v1"'));
  assert.ok(text.includes('command = "/Users/d/.relay/codex-auth"'));
  assert.ok(!/^profile\s*=/m.test(text) && !text.includes("[profiles."), "Codex 0.155 rejects a default profile key");
});

test("re-running replaces what it wrote, and removing restores the original exactly", () => {
  const once = withRelayCodexConfig(existing, opts).text;
  const twice = withRelayCodexConfig(once, { ...opts, agent: "codex.nina.mobile.dev.sodalabs.eth", model: "gpt-5.1" }).text;
  assert.equal(twice.split("[model_providers.relay]").length, 2);
  assert.equal(twice.split("# relay login saved:").length, 2, "the user's model is set aside once, not twice");
  assert.ok(twice.includes("codex.nina.mobile.dev.sodalabs.eth") && !twice.includes("codex.derek") && twice.includes('model = "gpt-5.1" # relay login'));
  assert.equal(withoutRelayCodexConfig(twice).trimEnd(), existing.trimEnd());
});

test("an empty or missing config gets just our lines", () => {
  const { text } = withRelayCodexConfig("", opts);
  assert.ok(text.startsWith('model_provider = "relay" # relay login'));
  assert.equal(withoutRelayCodexConfig(text), "");
});

test("tables the user already defines under our names are reported, ours are not", () => {
  assert.deepEqual(conflictingTables(existing), []);
  assert.deepEqual(conflictingTables(withRelayCodexConfig(existing, opts).text), []);
  assert.deepEqual(conflictingTables(`${existing}\n[model_providers.relay]\nname = "y"\n`), ["model_providers.relay"]);
});

test("the auth script execs codex-token, quoting paths", () => {
  assert.equal(authScript({ node: "/n/node", cli: "/a b/relay.mjs", viaNode: true, relayHome: "/h/.relay" }).split("\n")[2], "RELAY_HOME='/h/.relay' exec '/n/node' '/a b/relay.mjs' codex-token");
  assert.equal(authScript({ node: "/n/node", cli: "/repo/relay", viaNode: false, relayHome: "/h/it's" }).split("\n")[2], "RELAY_HOME='/h/it'\\''s' exec '/repo/relay' codex-token");
});
