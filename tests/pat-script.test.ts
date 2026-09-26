// The PAT script the relay serves at /pat (lib/relay/pat-script.ts, app/pat/route.ts): which names
// and hours it accepts, how it quotes them, that every shell parses it, and full runs with stub CLIs
// (on PATH, in ~/.local/bin, an impostor, none). Everything runs in a temporary HOME.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PAT_MAX_HOURS, parsePatQuery, patErrorScript, patHours, patName, patScript, scriptOrigin } from "../lib/relay/pat-script";

const NAME = "derek.cloudops.dev.sodalabs.eth";

test("name: a normalized ENS name of lowercase labels, nothing a shell could trip on", () => {
  for (const ok of [NAME, "sodalabs.eth", "codex.derek.cloudops.dev.sodalabs.eth", "a-b.eth", "0x.eth", "a-.eth", "a1.b2.eth"]) assert.equal(patName(ok), ok, ok);
  const hostile = [
    "",
    "eth",
    "Derek.eth",
    "bad'name.eth",
    "bad'name",
    "a b.eth",
    "a$(id).eth",
    "a`id`.eth",
    "a;id.eth",
    'a"b.eth',
    "a\\b.eth",
    "a\nb.eth",
    "a.eth\n",
    " a.eth",
    "a..eth",
    ".a.eth",
    "a.eth.",
    "-a.eth",
    "--help.eth",
    "a_b.eth",
    "xn--abc.eth",
    "ab--c.eth",
    "é.eth",
    "a/b.eth",
    "a%27b.eth",
    `${"a".repeat(252)}.eth`,
  ];
  for (const bad of hostile) assert.equal(patName(bad), null, JSON.stringify(bad));
  assert.equal(patName(`${"a".repeat(251)}.eth`), `${"a".repeat(251)}.eth`, "255 characters");
  assert.equal(patName(null), null);
  assert.equal(patName(undefined), null);
});

test("hours: a whole number from 1 to 168, written plainly", () => {
  assert.equal(PAT_MAX_HOURS, 168);
  for (const [raw, n] of [["1", 1], ["24", 24], ["168", 168]] as const) assert.equal(patHours(raw), n);
  for (const bad of ["", "0", "169", "1000", "024", "2e1", "1.5", "-1", "+1", " 24", "24 ", "0x10", "24h", "Infinity", "NaN", "24;id"]) {
    assert.equal(patHours(bad), null, JSON.stringify(bad));
  }
});

test("query: ?name= is required and strict, &hours= is optional; repeats are refused", () => {
  const q = (s: string) => parsePatQuery(new URLSearchParams(s));
  assert.deepEqual(q(`name=${NAME}`), { ok: true, name: NAME, hours: null });
  assert.deepEqual(q(`name=${NAME}&hours=12`), { ok: true, name: NAME, hours: 12 });
  assert.match((q("") as { error: string }).error, /name is required/);
  assert.match((q("name=") as { error: string }).error, /name is required/);
  assert.match((q("name=bad%27name") as { error: string }).error, /ENS name in lowercase/);
  assert.match((q("name=a.eth%0Aid") as { error: string }).error, /ENS name/);
  assert.match((q(`name=${NAME}&name=b.eth`) as { error: string }).error, /once/);
  assert.match((q(`name=${NAME}&hours=0`) as { error: string }).error, /1 to 168/);
  assert.match((q(`name=${NAME}&hours=169`) as { error: string }).error, /1 to 168/);
  assert.match((q(`name=${NAME}&hours=%24(id)`) as { error: string }).error, /1 to 168/);
  assert.match((q(`name=${NAME}&hours=1&hours=2`) as { error: string }).error, /once/);
});

test("script: name, hours and relay are single-quoted values; nothing runs before the last line", () => {
  const script = patScript({ relayUrl: "https://relay.derek2403.win", name: NAME, hours: 12 });
  assert.ok(script.startsWith("#!/bin/sh\n"));
  assert.match(script, /^set -eu$/m);
  assert.match(script, /^relay_url='https:\/\/relay\.derek2403\.win'$/m);
  assert.match(script, new RegExp(`^name='${NAME.replace(/\./g, "\\.")}'$`, "m"));
  assert.match(script, /^hours='12'$/m);
  assert.ok(script.includes(`#   curl -fsSL "https://relay.derek2403.win/pat?name=${NAME}" | sh >> .env`));
  assert.ok(script.includes(`# Runs your installed relay CLI: relay pat --name ${NAME} --hours 12`));
  assert.ok(script.includes('exec "$relay_bin" pat --name "$name" --hours "$hours" </dev/null'));
  assert.ok(script.trimEnd().endsWith('main "$@"'));
  assert.doesNotMatch(script, /@@[A-Z_]+@@/);

  const noHours = patScript({ relayUrl: "http://127.0.0.1:3000", name: "sodalabs.eth" });
  assert.match(noHours, /^hours=''$/m);
  assert.ok(noHours.includes("# Runs your installed relay CLI: relay pat --name sodalabs.eth\n"));

  // An unknown or hostile relay address is dropped (the CLI's own setting is used).
  assert.match(patScript({ relayUrl: null, name: NAME }), /^relay_url=''$/m);
  assert.match(patScript({ relayUrl: "http://a$(reboot).example", name: NAME }), /^relay_url=''$/m);
  assert.match(patScript({ relayUrl: "https://relay.acme.com/some/path?q", name: NAME }), /^relay_url='https:\/\/relay\.acme\.com'$/m);

  // Values that skipped parsePatQuery are still refused.
  assert.throws(() => patScript({ relayUrl: null, name: "a'$(id).eth" }), /invalid name/);
  assert.throws(() => patScript({ relayUrl: null, name: NAME, hours: 0 }), /invalid hours/);
  assert.throws(() => patScript({ relayUrl: null, name: NAME, hours: 1.5 }), /invalid hours/);
});

const shells = ["sh", "bash", "zsh", "dash"].filter((sh) => spawnSync("sh", ["-c", `command -v ${sh}`]).status === 0);

test("script: every available shell parses it and the error script", () => {
  assert.ok(shells.includes("sh"));
  for (const text of [patScript({ relayUrl: "https://relay.derek2403.win", name: NAME, hours: 24 }), patScript({ relayUrl: null, name: NAME }), patErrorScript("name is required")]) {
    for (const sh of shells) {
      const r = spawnSync(sh, ["-n"], { input: text, encoding: "utf8" });
      assert.equal(r.status, 0, `${sh} -n: ${r.stderr}`);
    }
  }
});

test("error script: prints the reason on stderr only and exits 1, so nothing lands in .env", () => {
  const r = spawnSync("sh", [], { input: patErrorScript("it's $(echo no) `echo no`\nsecond line"), encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "error: it's $(echo no) `echo no` second line\n");
});

// --- Full runs -----------------------------------------------------------------------------------

/** A stub relay CLI: logs its arguments, RELAY_URL and stdin, and prints .env lines like `relay pat`. */
const STUB = `#!/bin/sh
# Keyless Relay CLI (test stub)
{
  printf 'args:'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\\n'
  printf 'RELAY_URL=%s\\n' "$(printenv RELAY_URL || true)"
  printf 'stdin=%s\\n' "$(cat)"
} >> "$STUB_LOG"
printf '%s\\n' '# Keyless Relay PAT for stub' 'RELAY_BASE_URL=https://relay.example/v1' 'RELAY_API_KEY=kr1.stub' 'OPENAI_BASE_URL=https://relay.example/v1/openai' 'OPENAI_API_KEY=kr1.stub'
echo 'signed a PAT' >&2
`;
const IMPOSTOR = `#!/bin/sh\necho impostor ran >> "$STUB_LOG"\n`;

type Run = { code: number; stdout: string; stderr: string; log: string };

function run(script: string, setup: (home: string, bin: string) => void, env: Record<string, string> = {}): Run {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pat-test-"));
  const bin = path.join(home, "path-bin");
  fs.mkdirSync(bin);
  setup(home, bin);
  const log = path.join(home, "stub.log");
  const r = spawnSync("sh", [], {
    input: script,
    encoding: "utf8",
    cwd: home,
    env: { PATH: [bin, "/usr/bin", "/bin"].join(":"), HOME: home, STUB_LOG: log, ...env } as unknown as NodeJS.ProcessEnv,
    timeout: 30_000,
  });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr, log: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "" };
}

const put = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o755 });
};

test("run: the relay on PATH signs it; stdout is only the CLI's lines; RELAY_URL is the relay the script came from", () => {
  const r = run(patScript({ relayUrl: "https://relay.derek2403.win", name: NAME, hours: 12 }), (_home, bin) => put(path.join(bin, "relay"), STUB));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "# Keyless Relay PAT for stub\nRELAY_BASE_URL=https://relay.example/v1\nRELAY_API_KEY=kr1.stub\nOPENAI_BASE_URL=https://relay.example/v1/openai\nOPENAI_API_KEY=kr1.stub\n");
  assert.equal(r.stderr, "signed a PAT\n");
  assert.equal(r.log, `args: [pat] [--name] [${NAME}] [--hours] [12]\nRELAY_URL=https://relay.derek2403.win\nstdin=\n`);
});

test("run: the user's RELAY_URL wins; no hours means no --hours; an unknown relay sets none", () => {
  const withEnv = run(patScript({ relayUrl: "https://relay.derek2403.win", name: NAME }), (_h, bin) => put(path.join(bin, "relay"), STUB), { RELAY_URL: "http://127.0.0.1:3000" });
  assert.equal(withEnv.code, 0, withEnv.stderr);
  assert.equal(withEnv.log, `args: [pat] [--name] [${NAME}]\nRELAY_URL=http://127.0.0.1:3000\nstdin=\n`);

  const unknown = run(patScript({ relayUrl: null, name: NAME }), (_h, bin) => put(path.join(bin, "relay"), STUB));
  assert.equal(unknown.code, 0, unknown.stderr);
  assert.match(unknown.log, /^RELAY_URL=$/m);
});

test("run: falls back to ~/.local/bin/relay when relay isn't on PATH", () => {
  const r = run(patScript({ relayUrl: "https://relay.derek2403.win", name: NAME }), (home) => put(path.join(home, ".local", "bin", "relay"), STUB));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.log, /^args: \[pat\] \[--name\] \[derek\.cloudops\.dev\.sodalabs\.eth\]$/m);
});

test("run: another program called relay is never run; without the CLI it says how to install it", () => {
  const impostor = run(patScript({ relayUrl: "https://relay.derek2403.win", name: NAME }), (_h, bin) => put(path.join(bin, "relay"), IMPOSTOR));
  assert.equal(impostor.code, 1);
  assert.equal(impostor.stdout, "");
  assert.equal(impostor.log, "", "the impostor did not run");
  assert.match(impostor.stderr, /path-bin\/relay is not the Keyless Relay CLI/);
  assert.match(impostor.stderr, /curl -fsSL https:\/\/relay\.derek2403\.win\/install \| sh/);

  const none = run(patScript({ relayUrl: "https://relay.derek2403.win", name: NAME }), () => {});
  assert.equal(none.code, 1);
  assert.equal(none.stdout, "");
  assert.match(none.stderr, /^error: the Keyless Relay CLI \(relay\) is not installed/m);
  assert.match(none.stderr, /curl -fsSL https:\/\/relay\.derek2403\.win\/install \| sh/);

  const noOrigin = run(patScript({ relayUrl: null, name: NAME }), () => {});
  assert.match(noOrigin.stderr, /curl -fsSL <relay URL>\/install \| sh/);

  // A relay in the current folder (an untrusted checkout) is never picked up.
  const cwd = run(patScript({ relayUrl: null, name: NAME }), (home) => put(path.join(home, "relay"), STUB));
  assert.equal(cwd.code, 1);
  assert.equal(cwd.log, "");
});

// --- The route -------------------------------------------------------------------------------------

test("route: GET /pat answers the script as no-store, nosniff text; bad input is a 400 error script", async () => {
  const saved = process.env.RELAY_PUBLIC_URL;
  process.env.RELAY_PUBLIC_URL = "https://relay.derek2403.win";
  try {
    const { GET } = await import("../app/pat/route");
    const ok = GET(new Request(`http://127.0.0.1:3000/pat?name=${NAME}&hours=6`));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
    const text = await ok.text();
    assert.match(text, /^relay_url='https:\/\/relay\.derek2403\.win'$/m);
    assert.match(text, /^hours='6'$/m);

    for (const bad of ["/pat", "/pat?name=bad%27name", `/pat?name=${NAME}&hours=999`, "/pat?name=a.eth%3B%20reboot"]) {
      const r = GET(new Request(`http://127.0.0.1:3000${bad}`));
      assert.equal(r.status, 400, bad);
      assert.equal(r.headers.get("cache-control"), "no-store");
      const body = await r.text();
      assert.ok(body.startsWith("#!/bin/sh\n"), bad);
      assert.ok(!body.includes("reboot") && !body.includes("bad'name"), "the request's values are never echoed");
    }
  } finally {
    if (saved === undefined) delete process.env.RELAY_PUBLIC_URL;
    else process.env.RELAY_PUBLIC_URL = saved;
  }
});

test("origin: RELAY_PUBLIC_URL, else the Host the client used, never a hostile one", () => {
  const req = (host: string) => new Request("http://127.0.0.1:3000/pat?name=a.eth", { headers: { host } });
  assert.equal(scriptOrigin(req("relay.lan:3000"), "https://relay.derek2403.win"), "https://relay.derek2403.win");
  assert.equal(scriptOrigin(req("relay.lan:3000"), undefined), "http://relay.lan:3000");
  assert.equal(scriptOrigin(req("a$(id).example"), undefined), null);
  assert.equal(scriptOrigin(new Request("http://0.0.0.0:3000/pat", { headers: { "x-forwarded-host": "relay.derek2403.win", "x-forwarded-proto": "https" } }), ""), "https://relay.derek2403.win");
});
