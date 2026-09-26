import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  authScript,
  checkAuthAside,
  conflictingTables,
  isNameLogin,
  moveAuthAside,
  relayModelCatalog,
  restoreAuth,
  withRelayCodexConfig,
  withoutRelayCodexConfig,
} from "../scripts/lib/codex-config";

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
  assert.ok(!text.includes("requires_openai_auth"), "the auth command signs in; Codex's login screen isn't used");
});

test("re-running replaces what it wrote, and removing restores the original exactly", () => {
  const once = withRelayCodexConfig(existing, opts).text;
  const twice = withRelayCodexConfig(once, { ...opts, agent: "codex.nina.mobile.dev.sodalabs.eth", model: "gpt-5.1" }).text;
  assert.equal(twice.split("[model_providers.relay]").length, 2);
  assert.equal(twice.split("# relay login saved:").length, 2, "the user's model is set aside once, not twice");
  assert.ok(twice.includes("codex.nina.mobile.dev.sodalabs.eth") && !twice.includes("codex.derek") && twice.includes('model = "gpt-5.1" # relay login'));
  assert.equal(withoutRelayCodexConfig(twice), existing, "byte for byte");
  for (const original of ["a = 1", "a = 1\n\n\n", "\n# top comment\n[t]\nx = 1\n", "", "\n", "[t]\nx = 1", "# only a comment"]) {
    for (const o of [opts, { ...opts, authCommand: undefined, loginSecret: "A".repeat(43) }]) {
      const text = withRelayCodexConfig(original, o).text;
      assert.equal(withoutRelayCodexConfig(text), original, `byte for byte: ${JSON.stringify(original)}`);
      assert.equal(withRelayCodexConfig(text, o).text, text, "logging in twice writes the same file");
    }
  }
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

// --- Codex login (the default) ------------------------------------------------------------------

const SECRET = "A".repeat(43);
const loginOpts = { agent: "codex.derek.cloudops.dev.sodalabs.eth", relayUrl: "https://relay.derek2403.win/", loginSecret: SECRET, model: "gpt-5.3-codex" };

test("a Codex login points base_url at the login and makes Codex show its own login screen", () => {
  const { text } = withRelayCodexConfig(existing, loginOpts);
  assert.ok(text.includes('base_url = "https://relay.derek2403.win/api/relay/codex/login/v1"'), "no secret in the URL: Codex prints it in errors");
  assert.ok(text.includes(`http_headers = { "x-relay-login" = "${SECRET}" }`));
  assert.ok(text.includes("requires_openai_auth = true"));
  assert.ok(text.includes('name = "Keyless Relay (codex.derek.cloudops.dev.sodalabs.eth)"'));
  assert.ok(!text.includes("[model_providers.relay.auth]") && !text.includes("command ="), "no auth command");
  assert.ok(/\[notice\]\nhide_rate_limit_model_nudge = true/.test(text), "Codex doesn't offer to switch models near the cap");
  assert.equal(withoutRelayCodexConfig(text), existing);
  // Only an API-key sign-in, kept in auth.json: ChatGPT's token (or one in the keyring) would reach the relay.
  assert.ok(text.includes('forced_login_method = "api" # relay login\ncli_auth_credentials_store = "file" # relay login\n'));
  // Switching modes replaces the block.
  const back = withRelayCodexConfig(text, opts).text;
  assert.ok(!back.includes("requires_openai_auth") && !back.includes(SECRET) && back.includes("[model_providers.relay.auth]"));
  assert.ok(!back.includes("forced_login_method") && !back.includes("cli_auth_credentials_store"), "the auth command leaves Codex's sign-in settings alone");
  assert.equal(withoutRelayCodexConfig(back), existing);
});

test("the user's own sign-in settings are set aside during a Codex login and come back at logout", () => {
  const own = 'forced_login_method = "chatgpt"\ncli_auth_credentials_store = "keyring"\nmodel = "gpt-6-astra"\n\n[tui]\nx = 1\n';
  const { text } = withRelayCodexConfig(own, loginOpts);
  assert.ok(text.includes('# relay login saved: forced_login_method = "chatgpt"\n# relay login saved: cli_auth_credentials_store = "keyring"'));
  assert.equal(text.split(/^forced_login_method = /m).length, 2, "one active forced_login_method");
  assert.equal(text.split(/^cli_auth_credentials_store = /m).length, 2, "one active cli_auth_credentials_store");
  assert.equal(withoutRelayCodexConfig(text), own);
  assert.equal(withoutRelayCodexConfig(withRelayCodexConfig(text, opts).text), own, "switching to the auth command restores them too");
});

test("tables and notice keys Codex adds inside our block while logged in are kept at logout", () => {
  const { text } = withRelayCodexConfig(existing, loginOpts);
  // What Codex 0.157 does: a trusted folder's table goes at the end of the file, before our end marker,
  // and a dismissed notice joins the [notice] table (ours).
  const trusted = '[projects."/Users/d/relay-demo"]\ntrust_level = "trusted"';
  const edited = text
    .replace("hide_rate_limit_model_nudge = true\n", "hide_rate_limit_model_nudge = true\nhide_full_access_warning = true\n")
    .replace("# <<< relay", `\n${trusted}\n# <<< relay`);
  const after = withoutRelayCodexConfig(edited);
  assert.ok(!after.includes("model_providers") && !after.includes("# relay login"), "nothing of ours is left");
  assert.ok(!after.includes("hide_rate_limit_model_nudge") && !after.includes("x-relay-login"));
  assert.equal(after, `${existing}\n[notice]\nhide_full_access_warning = true\n\n${trusted}\n`);
  // Logging in again keeps them too, outside the new block.
  const again = withRelayCodexConfig(edited, loginOpts).text;
  assert.equal(again.split(trusted).length, 2);
  assert.ok(again.indexOf(trusted) < again.indexOf("# >>> relay"));
  assert.equal(withoutRelayCodexConfig(again), after);
});

test("the nudge key joins a [notice] table the user already has, and leaves one that sets it alone", () => {
  const withNotice = `${existing}\n[notice]\nhide_full_access_warning = true\n\n[notice.model_migrations]\n"gpt-5" = "gpt-5.1"\n`;
  const { text } = withRelayCodexConfig(withNotice, loginOpts);
  assert.equal(text.split(/^\[notice\]/m).length, 2, "one [notice] table");
  assert.ok(text.includes("[notice]\nhide_rate_limit_model_nudge = true # relay login\nhide_full_access_warning = true"));
  assert.equal(withoutRelayCodexConfig(text), withNotice);
  const ownNudge = `${existing}\n[notice]\nhide_rate_limit_model_nudge = false\n`;
  const kept = withRelayCodexConfig(ownNudge, loginOpts).text;
  assert.equal(kept.split("hide_rate_limit_model_nudge").length, 2, "the user's own choice stands");
  assert.equal(withoutRelayCodexConfig(kept), ownNudge);
  // Only a sub-table: a [notice] table after it is valid TOML.
  const onlySub = `${existing}\n[notice.model_migrations]\n"gpt-5" = "gpt-5.1"\n`;
  assert.ok(withRelayCodexConfig(onlySub, loginOpts).text.includes("[notice]\nhide_rate_limit_model_nudge = true\n# <<< relay"));
  const inline = `notice = { hide_full_access_warning = true }\n${existing}`;
  assert.ok(!withRelayCodexConfig(inline, loginOpts).text.includes("hide_rate_limit_model_nudge"), "never a duplicate notice table");
});

// --- auth.json aside and back -------------------------------------------------------------------------

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
const CHATGPT_AUTH = '{\n  "auth_mode": "chatgpt",\n  "OPENAI_API_KEY": null,\n  "tokens": { "access_token": "eyJ.real.token", "account_id": "acct-1" }\n}\n';
const NAME_LOGIN = '{\n  "auth_mode": "apikey",\n  "OPENAI_API_KEY": "derek.cloudops.dev.sodalabs.eth"\n}';

test("the user's auth.json is moved aside at login and restored byte for byte, mode included, at logout", () => {
  const home = tmpHome();
  const auth = path.join(home, "auth.json");
  fs.writeFileSync(auth, CHATGPT_AUTH, { mode: 0o600 });
  assert.deepEqual(moveAuthAside(home), { ok: true, action: "moved" });
  assert.ok(!fs.existsSync(auth), "Codex shows its login screen");
  assert.equal(fs.readFileSync(`${auth}.before-relay`, "utf8"), CHATGPT_AUTH);
  // In Codex the user types their ENS name: Codex writes this.
  fs.writeFileSync(auth, NAME_LOGIN, { mode: 0o600 });
  assert.equal(restoreAuth(home), "restored");
  assert.equal(fs.readFileSync(auth, "utf8"), CHATGPT_AUTH);
  assert.equal((fs.statSync(auth).mode & 0o777).toString(8), "600");
  assert.ok(!fs.existsSync(`${auth}.before-relay`));
});

test("with no auth.json there is nothing to move; the name login goes at logout", () => {
  const home = tmpHome();
  const auth = path.join(home, "auth.json");
  assert.deepEqual(moveAuthAside(home), { ok: true, action: "none" });
  fs.writeFileSync(auth, NAME_LOGIN);
  assert.equal(restoreAuth(home), "removed-name-login");
  assert.ok(!fs.existsSync(auth));
  assert.equal(restoreAuth(home), "none");
});

test("logging in again drops the old name login, keeps the first backup, and never overwrites a sign-in", () => {
  const home = tmpHome();
  const auth = path.join(home, "auth.json");
  fs.writeFileSync(auth, CHATGPT_AUTH);
  moveAuthAside(home);
  fs.writeFileSync(auth, NAME_LOGIN);
  assert.deepEqual(moveAuthAside(home), { ok: true, action: "removed-name-login" });
  assert.equal(fs.readFileSync(`${auth}.before-relay`, "utf8"), CHATGPT_AUTH);
  // A new ChatGPT sign-in while the backup exists: refused (nothing changes), and logout keeps both.
  fs.writeFileSync(auth, CHATGPT_AUTH.replace("acct-1", "acct-2"));
  const refused = checkAuthAside(home);
  assert.equal(refused.ok, false);
  assert.equal(moveAuthAside(home).ok, false);
  assert.equal(restoreAuth(home), "kept");
  assert.ok(fs.readFileSync(auth, "utf8").includes("acct-2") && fs.existsSync(`${auth}.before-relay`));
});

test("only a dotted API-key name counts as a name login", () => {
  assert.equal(isNameLogin(NAME_LOGIN), true);
  assert.equal(isNameLogin('{"auth_mode":"apikey","OPENAI_API_KEY":"Derek.CloudOps.dev.sodalabs.eth"}'), true, "typed with capitals");
  assert.equal(isNameLogin('{"auth_mode":"apikey","OPENAI_API_KEY":"sk-proj-abc123"}'), false);
  // A gateway's JWT-style API key is dotted too: deleting it would lose the user's real key.
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEyMyIsImlhdCI6MTcwMDAwMDAwMH0.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU";
  assert.equal(isNameLogin(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: jwt })), false);
  assert.equal(isNameLogin(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: jwt.replace(/^eyJ/, "abc") })), false, "not a .eth name");
  assert.equal(isNameLogin('{"auth_mode":"apikey","OPENAI_API_KEY":"a..eth"}'), false);
  // A DNS-alias name counts only when it's one the CLI logs in with.
  const alias = '{"auth_mode":"apikey","OPENAI_API_KEY":"derek.cloudops.dev"}';
  assert.equal(isNameLogin(alias), false);
  assert.equal(isNameLogin(alias, ["derek.cloudops.dev"]), true);
  assert.equal(isNameLogin(CHATGPT_AUTH), false);
  assert.equal(isNameLogin("not json"), false);
  assert.equal(isNameLogin(null), false);
});

test("a config written by the previous relay login (the old layout) is cleaned up too", () => {
  const old = 'model_provider = "relay" # relay login\nmodel = "gpt-5.3-codex" # relay login\n# relay login saved: model = "gpt-6-astra"\n\n[features]\nfoo = true\n\n# >>> relay: written by `relay login`; `relay logout` removes it\n[model_providers.relay]\nname = "Keyless Relay (codex.x.acme.eth)"\nbase_url = "https://r/api/relay/codex/v1"\nwire_api = "responses"\n\n[model_providers.relay.auth]\ncommand = "/Users/d/.relay/codex-auth"\nrefresh_interval_ms = 240000\n# <<< relay\n';
  assert.equal(withoutRelayCodexConfig(old), 'model = "gpt-6-astra"\n\n[features]\nfoo = true\n');
  const upgraded = withRelayCodexConfig(old, loginOpts).text;
  assert.ok(!upgraded.includes("codex-auth") && upgraded.includes("requires_openai_auth = true"));
  assert.equal(withoutRelayCodexConfig(upgraded), 'model = "gpt-6-astra"\n\n[features]\nfoo = true\n');
});

test("the relay's model catalog line sets the user's own aside and comes back at logout", () => {
  const mine = 'model_catalog_json = "/Users/d/my-models.json"\nmodel = "gpt-6-astra"\n';
  const { text } = withRelayCodexConfig(mine, { ...loginOpts, modelCatalog: "/Users/d/.codex/relay-models.json" });
  assert.ok(text.includes('model_catalog_json = "/Users/d/.codex/relay-models.json" # relay login'));
  assert.ok(text.includes('# relay login saved: model_catalog_json = "/Users/d/my-models.json"'));
  assert.equal(text.split(/^model_catalog_json = /m).length, 2, "only one active catalog key");
  assert.equal(withoutRelayCodexConfig(text), mine);
  // Without a catalog, the user's own stays as it is.
  assert.ok(withRelayCodexConfig(mine, loginOpts).text.includes('\nmodel_catalog_json = "/Users/d/my-models.json"\n'));
});

test("the catalog copies Codex's bundled template under the relay model's name, or keeps its own entry", () => {
  const entry = (slug: string, extra: Record<string, unknown> = {}) => ({ slug, display_name: slug, visibility: "hide", base_instructions: `be ${slug}`, context_window: 272000, supported_in_api: true, ...extra });
  const bundled = JSON.stringify({ models: [entry("gpt-6-astra"), entry("gpt-5.4", { upgrade: { model: "gpt-5.5" } })] });
  const copied = JSON.parse(relayModelCatalog(bundled, "gpt-5.3-codex") ?? "null");
  assert.equal(copied.models.length, 1);
  assert.deepEqual(
    { ...copied.models[0] },
    { ...entry("gpt-5.4"), slug: "gpt-5.3-codex", display_name: "gpt-5.3-codex", description: "Through Keyless Relay", visibility: "list", upgrade: null, availability_nux: null },
  );
  // Codex's own entry for the model wins, unchanged.
  assert.deepEqual(JSON.parse(relayModelCatalog(bundled, "gpt-6-astra") ?? "null").models, [entry("gpt-6-astra")]);
  // No gpt-5.4: the first entry the API supports; its template text may be model_messages' instead.
  const other = JSON.stringify({ models: [{ slug: "x", supported_in_api: false, base_instructions: "no" }, { slug: "y", supported_in_api: true, model_messages: { instructions_template: "hi" } }] });
  assert.equal(JSON.parse(relayModelCatalog(other, "gpt-5.3-codex") ?? "null").models[0].model_messages.instructions_template, "hi");
  // Entries without instructions would stop Codex from starting: never used.
  assert.equal(relayModelCatalog(JSON.stringify({ models: [{ slug: "gpt-5.4", supported_in_api: true, model_messages: null }] }), "gpt-5.3-codex"), null);
  assert.equal(relayModelCatalog("not json", "gpt-5.3-codex"), null);
  assert.equal(relayModelCatalog("null", "gpt-5.3-codex"), null);
  assert.equal(relayModelCatalog('{"models":{}}', "gpt-5.3-codex"), null);
});
