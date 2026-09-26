import assert from "node:assert/strict";
import test from "node:test";

import {
  countdown,
  durationSeconds,
  formatTtl,
  isResumable,
  patCommand,
  patEnv,
  patEnvPreview,
  patNameOk,
  patWeatherCheck,
  relayOrigin,
  reservedSubagentLabels,
  sessionExpiry,
  sessionLabel,
  sessionPath,
  sessionProblem,
  subagentCommand,
  subagentGate,
  tokenExpiry,
  topUpAmount,
} from "../components/live/sessions/logic";

test("token expiry is the name's expiry or the relay's max TTL, whichever is first", () => {
  assert.equal(tokenExpiry(10_000, 1_000, 86_400), 10_000);
  assert.equal(tokenExpiry(1_000_000, 1_000, 86_400), 87_400);
  assert.equal(tokenExpiry(5_000, 5_000, 3_600), 5_000);
  assert.equal(formatTtl(86_400), "24 hours");
  assert.equal(formatTtl(3_600), "1 hour");
  assert.equal(formatTtl(90 * 60), "1h 30m");
});

test("session and subagent expiries: duration, custom minutes, and never past the agent", () => {
  assert.equal(durationSeconds("3600", ""), 3600);
  assert.equal(durationSeconds("custom", "20"), 1200);
  assert.equal(durationSeconds("custom", "abc"), 0);
  assert.equal(durationSeconds("custom", "-5"), 0);
  assert.equal(sessionExpiry(1_000, 600), 1_600);
  assert.equal(sessionExpiry(1_000, 600, null), 1_600);
  assert.equal(sessionExpiry(1_000, 600, 1_200), 1_200);
  assert.equal(sessionExpiry(1_000, 600, 5_000), 1_600);
});

test("one transaction only with a ready minter, a live registry and a fresh label off any plan", () => {
  const base = { minterReady: true, registryLive: true, registered: false, bundleRead: true, onPlan: false };
  assert.equal(sessionPath(base), "one-tx");
  assert.equal(sessionPath({ ...base, minterReady: false }), "two-tx");
  assert.equal(sessionPath({ ...base, registryLive: false }), "two-tx");
  assert.equal(sessionPath({ ...base, registered: true }), "two-tx");
  assert.equal(sessionPath({ ...base, bundleRead: false }), "two-tx");
  assert.equal(sessionPath({ ...base, onPlan: true }), "two-tx");
});

test("resume a half-done session only for an agent owner or a key kept here", () => {
  const half = { registered: true, bundleRead: true, hasBundle: false, onPlan: false, ownerIsMember: false, ownerKeyHere: false };
  assert.equal(isResumable(half), true);
  assert.equal(isResumable({ ...half, ownerIsMember: true }), false, "a member stuck after step 1 must not get agent limits");
  assert.equal(isResumable({ ...half, ownerIsMember: true, ownerKeyHere: true }), true);
  assert.equal(isResumable({ ...half, ownerIsMember: undefined }), false);
  assert.equal(isResumable({ ...half, hasBundle: true }), false);
  assert.equal(isResumable({ ...half, bundleRead: false }), false);
  assert.equal(isResumable({ ...half, registered: false }), false);
});

test("labels and the start problem, in SRC order", () => {
  assert.equal(sessionLabel("laptop"), "laptop");
  assert.equal(sessionLabel("a.b"), null);
  assert.equal(sessionLabel(null), null);
  assert.equal(sessionLabel("codex", reservedSubagentLabels("codex.derek.dev.acme.eth")), null);
  assert.equal(sessionLabel("agent", reservedSubagentLabels("codex.derek.dev.acme.eth")), null);
  const ok = {
    labelInput: "laptop",
    label: "laptop",
    reserved: false,
    childName: "laptop.derek.acme.eth",
    checking: false,
    registered: false,
    readFailed: false,
    resumable: false,
    seconds: 3600,
    pasteMode: false,
    pastedOk: false,
    pasted: "",
    bundleError: null,
  };
  assert.equal(sessionProblem(ok), null);
  assert.equal(sessionProblem({ ...ok, label: null, labelInput: "" }), null);
  assert.match(sessionProblem({ ...ok, label: null, labelInput: "a.b" })!, /simple label/);
  assert.match(sessionProblem({ ...ok, label: null, reserved: true })!, /reserved/);
  assert.equal(sessionProblem({ ...ok, checking: true, registered: true }), null);
  assert.match(sessionProblem({ ...ok, registered: true })!, /already taken/);
  assert.equal(sessionProblem({ ...ok, registered: true, resumable: true }), null);
  assert.match(sessionProblem({ ...ok, registered: true, readFailed: true })!, /Couldn't read/);
  assert.equal(sessionProblem({ ...ok, seconds: 0 }), "Pick how long.");
  assert.equal(sessionProblem({ ...ok, pasteMode: true }), null);
  assert.equal(sessionProblem({ ...ok, pasteMode: true, pasted: "0x12" }), "That isn't an address.");
  assert.equal(sessionProblem({ ...ok, bundleError: "Pick at least one API." }), "Pick at least one API.");
});

test("subagent gating: ready, setup, blocked", () => {
  const predicted = "0x" + "b".repeat(40);
  const other = "0x" + "c".repeat(40);
  const base = { active: true, subregistry: null, predicted, canRegisterBelow: false, canSetSubregistry: true, loading: false };
  const name = "codex.derek.acme.eth";
  assert.deepEqual(subagentGate(base, name), { mode: "setup", registry: predicted });
  assert.equal(subagentGate({ ...base, loading: true }, name).mode, "loading");
  assert.equal(subagentGate({ ...base, predicted: null }, name).mode, "loading");
  assert.equal(subagentGate({ ...base, canSetSubregistry: false }, name).mode, "blocked");
  assert.equal(subagentGate({ ...base, active: false }, name).mode, "blocked");
  assert.deepEqual(subagentGate({ ...base, subregistry: other, canRegisterBelow: true }, name), { mode: "ready", registry: other });
  const cli = subagentGate({ ...base, subregistry: other }, name);
  assert.equal(cli.mode, "blocked");
  assert.match(cli.mode === "blocked" ? cli.reason : "", /relay CLI/);
  // Our own registry already attached: finish its setup (setParent) as part of the flow.
  assert.deepEqual(subagentGate({ ...base, subregistry: predicted.toUpperCase().replace("0X", "0x"), canRegisterBelow: true }, name).mode, "setup");
});

test("CLI snippets and countdown", () => {
  const bundle = { keys: ["codex", "openai-images"] as never, caps: { codex: 1 }, maxes: { "openai-images": 2 }, period: "total" as const };
  assert.equal(subagentCommand("research", bundle, 20 * 60), "relay subagent create research --codex 1 --images 2 --minutes 20");
  assert.equal(subagentCommand(null, null, 0), "relay subagent create research");
  assert.equal(countdown(null, 100), null);
  assert.equal(countdown(200, 0), null);
  assert.equal(countdown(160, 100), "Ends in 1m 00s");
  assert.equal(countdown(100, 100), "Ended");
});

test("agent top-up: double what's missing, at least the minimum", () => {
  assert.equal(topUpAmount(100n, 0n, 50n), 200n);
  assert.equal(topUpAmount(100n, 180n, 50n), 50n);
  assert.equal(topUpAmount(100n, 500n, 50n), 50n);
});

test("PAT for apps: relay origin, curl snippet and .env lines", () => {
  // The relay's public URL wins; a loopback one seen from another host falls back to the page.
  assert.equal(relayOrigin("https://relay.derek2403.win/api/relay", "https://relay.derek2403.win"), "https://relay.derek2403.win");
  assert.equal(relayOrigin("http://127.0.0.1:3000/api/relay", "https://relay.example.com"), "https://relay.example.com");
  assert.equal(relayOrigin("http://127.0.0.1:3000/api/relay", "http://localhost:3000"), "http://127.0.0.1:3000");
  assert.equal(relayOrigin(undefined, "http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.equal(relayOrigin("https://a$b.example/api/relay", null), null); // nothing a shell could trip on
  assert.equal(relayOrigin("ftp://relay.example", null), null);
  assert.equal(relayOrigin(null, null), null);

  assert.equal(patNameOk("derek.cloudops.dev.sodalabs.eth"), true);
  assert.equal(patNameOk("codex.derek.cloudops.dev.sodalabs.eth"), true);
  for (const bad of ["eth", "Derek.sodalabs.eth", "derek..eth", "de rek.eth", "derek.eth;rm", `${"a".repeat(252)}.eth`, "", null, undefined]) {
    assert.equal(patNameOk(bad), false, String(bad));
  }

  const origin = "https://relay.derek2403.win";
  assert.equal(
    patCommand(origin, "derek.cloudops.dev.sodalabs.eth"),
    'curl -fsSL "https://relay.derek2403.win/pat?name=derek.cloudops.dev.sodalabs.eth" | sh >> .env',
  );
  assert.equal(
    patEnv(origin, "codex.derek.acme.eth", "kr1.abc.def", 1_790_000_000),
    [
      "# Keyless Relay PAT for codex.derek.acme.eth · expires 2026-09-21T14:13:20.000Z · https://relay.derek2403.win",
      "RELAY_BASE_URL=https://relay.derek2403.win/v1",
      "RELAY_API_KEY=kr1.abc.def",
      "OPENAI_BASE_URL=https://relay.derek2403.win/v1/openai",
      "OPENAI_API_KEY=kr1.abc.def",
    ].join("\n"),
  );
  assert.deepEqual(
    patEnvPreview(origin).split("\n").map((l) => l.split("=")[0]),
    ["RELAY_BASE_URL", "RELAY_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_KEY"],
  );
  assert.match(patWeatherCheck, /curl -s "\$RELAY_BASE_URL\/weather\/data\/2\.5\/weather\?q=Tokyo&units=metric"/);
  assert.match(patWeatherCheck, /-H "Authorization: Bearer \$RELAY_API_KEY"/);
  assert.doesNotMatch(patWeatherCheck, /appid/, "the OpenWeatherMap key stays on the relay");
});
