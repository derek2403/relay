import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "./config";
import { CredentialStore, CredentialsError, EnvBinding, checkUpstreamValue, credentialsRuntime, customViews, initCredentials, keyViews, redact } from "./credentials";
import { UnsealError, mac, safeEqual, seal, secretProblem, unseal } from "./credentials-crypto";
import { credentialSlots, slotFor } from "./credentials-types";
import { tempDir } from "./testkit";

const SECRET = "a".repeat(64);
const OTHER = "b".repeat(64);

const storeIn = (dir: string, secret: string | null = SECRET) => new CredentialStore(path.join(dir, "credentials.json"), secret);

test("sealing round-trips and any change is detected", () => {
  const sealed = seal(SECRET, "hello credentials");
  assert.equal(unseal(SECRET, sealed), "hello credentials");
  assert.equal(JSON.stringify(sealed).includes("hello"), false);
  assert.notEqual(seal(SECRET, "x").iv, seal(SECRET, "x").iv, "fresh IV per seal");

  const flip = (b64: string) => {
    const buf = Buffer.from(b64, "base64");
    buf[0] ^= 1;
    return buf.toString("base64");
  };
  assert.throws(() => unseal(OTHER, sealed), UnsealError);
  assert.throws(() => unseal(SECRET, { ...sealed, ct: flip(sealed.ct) }), UnsealError);
  assert.throws(() => unseal(SECRET, { ...sealed, tag: flip(sealed.tag) }), UnsealError);
  assert.throws(() => unseal(SECRET, { ...sealed, salt: flip(sealed.salt) }), UnsealError);
  assert.throws(() => unseal(SECRET, { ...sealed, iv: flip(sealed.iv) }), UnsealError);
  assert.throws(() => unseal(SECRET, { ...sealed, v: 2 }), UnsealError);
  assert.throws(() => unseal(SECRET, null), UnsealError);
});

test("RELAY_SECRET must be 32+ characters; MACs are keyed and compared in constant time", () => {
  assert.match(secretProblem(undefined)!, /not set/);
  assert.match(secretProblem("short")!, /too short/);
  assert.equal(secretProblem(SECRET), null);
  assert.equal(mac(SECRET, "a", "x"), mac(SECRET, "a", "x"));
  assert.notEqual(mac(SECRET, "a", "x"), mac(SECRET, "b", "x"), "purpose separates keys");
  assert.notEqual(mac(SECRET, "a", "x"), mac(OTHER, "a", "x"));
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abcd"), false);
});

test("hints never reveal more than a prefix and the last characters", () => {
  assert.equal(redact("sk-proj-abcdefghijklmnopqrstuvwxyz3f2a"), "sk-p••••••••3f2a");
  assert.equal(redact("ghp_0123456789abcdefghij"), "ghp_••••••••ghij");
  assert.equal(redact("0123456789abcdefghijkl"), "••••••••ijkl", "no recognizable prefix");
  assert.equal(redact("0123456789abcd"), "••••••••abcd", "12-19 characters: no prefix");
  assert.equal(redact("short-key"), "••••ey", "under 12 characters: last 2 only");
  assert.equal(redact("sk-proj-" + "x".repeat(200) + "3f2a"), "sk-p••••••••3f2a", "length is not revealed");
});

test("slots: one per catalog key variable (OpenAI shared) plus the Mailchimp upstream", () => {
  const slots = credentialSlots();
  const openai = slots.find((s) => s.env === "OPENAI_API_KEY")!;
  assert.deepEqual(openai.apis, ["codex", "openai-images"]);
  assert.equal(new Set(slots.map((s) => s.env)).size, slots.length);
  assert.equal(slotFor("RELAY_UPSTREAM_MAILCHIMP")?.secret, false);
  assert.equal(slotFor("RELAY_ROOT_OWNER"), null, "settings outside the catalog can't be stored");
  assert.equal(checkUpstreamValue("RELAY_UPSTREAM_MAILCHIMP", "us21"), "https://us21.api.mailchimp.com");
  assert.equal(checkUpstreamValue("RELAY_UPSTREAM_MAILCHIMP", "https://US21.api.mailchimp.com/"), "https://us21.api.mailchimp.com");
  assert.throws(() => checkUpstreamValue("RELAY_UPSTREAM_MAILCHIMP", "https://evil.example/us21.api.mailchimp.com"), CredentialsError);
  assert.throws(() => checkUpstreamValue("RELAY_UPSTREAM_MAILCHIMP", "http://us21.api.mailchimp.com"), CredentialsError);
});

test("slots: MultiBaas keeps its key and deployment URL together, and the URL must be an https multibaas.com host", () => {
  const key = slotFor("MULTIBAAS_API_KEY")!;
  const url = slotFor("MULTIBAAS_URL")!;
  assert.deepEqual([key.apis, key.secret, key.label], [["multibaas"], true, "MultiBaas API key"]);
  assert.deepEqual([url.apis, url.secret, url.kind, url.label], [["multibaas"], false, "upstream", "MultiBaas deployment URL"]);
  assert.equal(checkUpstreamValue("MULTIBAAS_URL", "https://KKK123.multibaas.com/"), "https://kkk123.multibaas.com");
  assert.equal(checkUpstreamValue("MULTIBAAS_URL", "https://kkk123.multibaas.com/api/v0"), "https://kkk123.multibaas.com");
  // The relay sends its MultiBaas key to this host: nothing else is accepted.
  for (const bad of ["http://kkk123.multibaas.com", "https://kkk123.multibaas.com.evil.example", "https://evil.example/kkk123.multibaas.com", "https://a.b.multibaas.com", "kkk123", "https://kkk123.multibaas.com/other"]) {
    assert.throws(() => checkUpstreamValue("MULTIBAAS_URL", bad), CredentialsError, bad);
  }
});

test("the store persists encrypted with mode 0600 and reloads", () => {
  const dir = tempDir();
  const store = storeIn(dir);
  store.setKey("OPENAI_API_KEY", "  sk-proj-secretvalue1234567890  ", 1000);
  store.setKey("RELAY_UPSTREAM_MAILCHIMP", "us7", 1001);
  const id = store.addCustom({ label: "Acme CRM", value: "crm-secret-value-123456", note: "https://crm.acme.test" }, 1002);
  const file = path.join(dir, "credentials.json");
  const raw = fs.readFileSync(file, "utf8");
  assert.equal(raw.includes("sk-proj"), false);
  assert.equal(raw.includes("Acme"), false, "labels are encrypted too");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ["credentials.json"], "no temp files left");

  const again = storeIn(dir);
  assert.equal(again.error, null);
  assert.deepEqual(again.data.keys.OPENAI_API_KEY, { value: "sk-proj-secretvalue1234567890", updatedAt: 1000 });
  assert.equal(again.data.keys.RELAY_UPSTREAM_MAILCHIMP.value, "https://us7.api.mailchimp.com");
  assert.equal(again.data.custom[id].label, "Acme CRM");
  assert.deepEqual(again.desiredEnv(), { OPENAI_API_KEY: "sk-proj-secretvalue1234567890", RELAY_UPSTREAM_MAILCHIMP: "https://us7.api.mailchimp.com" });

  again.setKey("OPENAI_API_KEY", null);
  again.updateCustom(id, { value: "" });
  assert.equal(storeIn(dir).data.keys.OPENAI_API_KEY, undefined);
  assert.equal(storeIn(dir).data.custom[id].value, null);
  again.deleteCustom(id);
  assert.equal(storeIn(dir).data.custom[id], undefined);
});

test("bad values are refused: whitespace inside, control characters, unknown variables", () => {
  const store = storeIn(tempDir());
  assert.throws(() => store.setKey("OPENAI_API_KEY", "sk-abc\r\nx-evil: 1"), (e: CredentialsError) => e.status === 400);
  assert.throws(() => store.setKey("OPENAI_API_KEY", "two words"), (e: CredentialsError) => e.status === 400);
  assert.throws(() => store.setKey("OPENAI_API_KEY", 42), (e: CredentialsError) => e.status === 400);
  assert.throws(() => store.setKey("RELAY_SECRET", "x".repeat(40)), (e: CredentialsError) => e.status === 404);
  assert.throws(() => store.addCustom({ label: "" }), (e: CredentialsError) => e.status === 400);
});

test("a file that can't be opened is never overwritten", () => {
  const dir = tempDir();
  storeIn(dir).setKey("GITHUB_TOKEN", "github_pat_abcdefghijklmnop");
  const file = path.join(dir, "credentials.json");
  const before = fs.readFileSync(file, "utf8");

  const wrongSecret = storeIn(dir, OTHER);
  assert.match(wrongSecret.error!, /can't be decrypted/);
  assert.deepEqual(wrongSecret.desiredEnv(), {});
  assert.throws(() => wrongSecret.setKey("GITHUB_TOKEN", "github_pat_other_value_xyz"), (e: CredentialsError) => e.status === 503);
  assert.equal(fs.readFileSync(file, "utf8"), before);

  fs.writeFileSync(file, "{not json");
  const damaged = storeIn(dir);
  assert.match(damaged.error!, /damaged/);
  assert.throws(() => damaged.setKey("GITHUB_TOKEN", "github_pat_other_value_xyz"), (e: CredentialsError) => e.status === 503);
  assert.equal(fs.readFileSync(file, "utf8"), "{not json");

  fs.writeFileSync(file, before);
  const noSecret = storeIn(dir, null);
  assert.match(noSecret.error!, /RELAY_SECRET is not set/);
  assert.throws(() => noSecret.setKey("GITHUB_TOKEN", "github_pat_other_value_xyz"), (e: CredentialsError) => e.status === 503);

  const fresh = storeIn(tempDir(), "too-short");
  assert.equal(fresh.error, null);
  assert.match(fresh.writeProblem()!, /too short/);
});

test("stored keys drive the environment the relay reads; clearing restores the original (OPENAI_API_KEY serves codex and openai-images)", () => {
  const env: Record<string, string | undefined> = { RELAY_ROOT_NAME: "acme.eth", ANTHROPIC_API_KEY: "sk-ant-from-env-0000000000" };
  const store = storeIn(tempDir());
  const binding = new EnvBinding();
  const config = loadConfig(env);
  assert.equal(config.isConfigured("codex"), false);
  assert.equal(config.isConfigured("openai-images"), false);

  store.setKey("OPENAI_API_KEY", "sk-proj-stored-000000000000");
  store.setKey("ANTHROPIC_API_KEY", "sk-ant-stored-11111111111111");
  binding.apply(env, store.desiredEnv());
  assert.equal(env.OPENAI_API_KEY, "sk-proj-stored-000000000000");
  assert.equal(config.keyFor("codex"), "sk-proj-stored-000000000000", "config reads the environment on demand");
  assert.equal(config.isConfigured("codex"), true);
  assert.equal(config.isConfigured("openai-images"), true);
  assert.equal(config.keyFor("claude"), "sk-ant-stored-11111111111111", "stored value wins over the environment");

  const views = keyViews(store, binding, env, false);
  const claude = views.find((v) => v.env === "ANTHROPIC_API_KEY")!;
  assert.equal(claude.source, "store");

  store.setKey("ANTHROPIC_API_KEY", null);
  store.setKey("OPENAI_API_KEY", null);
  binding.apply(env, store.desiredEnv());
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-from-env-0000000000", "original restored");
  assert.equal("OPENAI_API_KEY" in env, false, "a variable the environment didn't have is removed again");
  assert.equal(config.isConfigured("codex"), false);
  assert.equal(keyViews(store, binding, env, false).find((v) => v.env === "ANTHROPIC_API_KEY")!.source, "env");
});

test("weather's OPENWEATHER_API_KEY is a slot from the catalog; stored on the Providers page, it configures weather", () => {
  const slot = slotFor("OPENWEATHER_API_KEY")!;
  assert.deepEqual([slot.apis, slot.secret, slot.kind, slot.label], [["weather"], true, "key", "Weather (OpenWeatherMap) key"]);

  const env: Record<string, string | undefined> = { RELAY_ROOT_NAME: "acme.eth" };
  const store = storeIn(tempDir());
  const binding = new EnvBinding();
  const config = loadConfig(env);
  assert.equal(config.isConfigured("weather"), false);
  store.setKey("OPENWEATHER_API_KEY", "  0123456789abcdef0123456789abcdef  ");
  binding.apply(env, store.desiredEnv());
  assert.equal(config.keyFor("weather"), "0123456789abcdef0123456789abcdef");
  assert.equal(config.isConfigured("weather"), true);
  const view = keyViews(store, binding, env, false).find((v) => v.env === "OPENWEATHER_API_KEY")!;
  assert.deepEqual([view.set, view.source, view.hint], [true, "store", null], "anonymous callers never get a hint");
  store.setKey("OPENWEATHER_API_KEY", null);
  binding.apply(env, store.desiredEnv());
  assert.equal(config.isConfigured("weather"), false);
});

test("upstream overrides apply like keys (RELAY_UPSTREAM_MAILCHIMP)", () => {
  const env: Record<string, string | undefined> = {};
  const store = storeIn(tempDir());
  const binding = new EnvBinding();
  store.setKey("RELAY_UPSTREAM_MAILCHIMP", "us21");
  binding.apply(env, store.desiredEnv());
  assert.equal(loadConfig(env).upstreams.mailchimp, "https://us21.api.mailchimp.com");
  store.setKey("RELAY_UPSTREAM_MAILCHIMP", null);
  binding.apply(env, store.desiredEnv());
  assert.equal(loadConfig(env).upstreams.mailchimp, "https://us1.api.mailchimp.com");
});

test("an environment reset (dev .env reload) becomes the new original and the stored value is applied again", () => {
  const env: Record<string, string | undefined> = { OPENAI_API_KEY: "sk-env-one-000000000000" };
  const binding = new EnvBinding();
  binding.apply(env, { OPENAI_API_KEY: "sk-stored-0000000000000" });
  env.OPENAI_API_KEY = "sk-env-two-000000000000"; // what a reload does
  assert.equal(binding.original(env, "OPENAI_API_KEY"), "sk-env-two-000000000000");
  binding.apply(env, { OPENAI_API_KEY: "sk-stored-0000000000000" });
  assert.equal(env.OPENAI_API_KEY, "sk-stored-0000000000000");
  binding.apply(env, {});
  assert.equal(env.OPENAI_API_KEY, "sk-env-two-000000000000");
});

test("views: anonymous callers get set/source/updatedAt only; the owner gets hints and non-secret values", () => {
  const env: Record<string, string | undefined> = { GITHUB_TOKEN: "github_pat_fromenv_abcdefgh" };
  const store = storeIn(tempDir());
  const binding = new EnvBinding();
  store.setKey("OPENAI_API_KEY", "sk-proj-stored-abcdefghij1234", 5);
  store.setKey("RELAY_UPSTREAM_MAILCHIMP", "us7", 6);
  store.addCustom({ label: "Acme CRM", value: "crm-value-abcdefghijkl", note: "https://crm.acme.test" }, 7);
  binding.apply(env, store.desiredEnv());

  const anon = keyViews(store, binding, env, false);
  const anonJson = JSON.stringify({ anon, custom: customViews(store, false) });
  for (const secret of ["sk-proj-stored", "github_pat_fromenv", "crm-value", "us7.api", "crm.acme"]) assert.equal(anonJson.includes(secret), false, secret);
  const openai = anon.find((v) => v.env === "OPENAI_API_KEY")!;
  assert.deepEqual([openai.set, openai.source, openai.updatedAt, openai.hint], [true, "store", 5, null]);
  const github = anon.find((v) => v.env === "GITHUB_TOKEN")!;
  assert.deepEqual([github.set, github.source, github.updatedAt], [true, "env", null]);
  assert.equal(anon.find((v) => v.env === "SLACK_BOT_TOKEN")!.source, null);

  const owner = keyViews(store, binding, env, true);
  const ownerJson = JSON.stringify({ owner, custom: customViews(store, true) });
  assert.equal(ownerJson.includes("sk-proj-stored-abcdefghij1234"), false, "never the whole secret");
  assert.equal(owner.find((v) => v.env === "OPENAI_API_KEY")!.hint, "sk-p••••••••1234");
  assert.equal(owner.find((v) => v.env === "GITHUB_TOKEN")!.hint, "gith••••••••efgh");
  const mailchimp = owner.find((v) => v.env === "RELAY_UPSTREAM_MAILCHIMP")!;
  assert.equal(mailchimp.value, "https://us7.api.mailchimp.com");
  const [custom] = customViews(store, true);
  assert.equal(custom.hint, "crm-••••••••ijkl");
  assert.equal(custom.note, "https://crm.acme.test");
});

test("server start (instrumentation): the stored file is loaded and applied; a new secret or data dir reloads", () => {
  const dir = tempDir();
  storeIn(dir).setKey("OPENAI_API_KEY", "sk-proj-from-file-000000000");
  const env: Record<string, string | undefined> = { RELAY_DATA_DIR: dir, RELAY_SECRET: SECRET, OPENAI_API_KEY: "sk-env-000000000000" };
  const runtime = initCredentials(env);
  assert.equal(runtime.store.error, null);
  assert.equal(env.OPENAI_API_KEY, "sk-proj-from-file-000000000");
  assert.equal(loadConfig(env).isConfigured("codex"), true);

  env.RELAY_SECRET = OTHER; // the file no longer opens: nothing applied, original back
  const other = credentialsRuntime(env);
  assert.match(other.store.error!, /can't be decrypted/);
  assert.equal(env.OPENAI_API_KEY, "sk-env-000000000000");

  env.RELAY_SECRET = SECRET;
  credentialsRuntime(env);
  assert.equal(env.OPENAI_API_KEY, "sk-proj-from-file-000000000");
  env.RELAY_DATA_DIR = tempDir();
  credentialsRuntime(env);
  assert.equal(env.OPENAI_API_KEY, "sk-env-000000000000");
});
