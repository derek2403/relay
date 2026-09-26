// The installer the relay serves at /install.sh (lib/relay/install-script.ts): which relay address it
// bakes in, how it is quoted, that every shell parses it, and full runs against a local HTTP server
// with a stub CLI (checksum, 404, links it may and may not replace, old Node.js, PATH hints,
// config.json and install.json). Everything runs in a temporary HOME; nothing leaves this machine.

import assert from "node:assert/strict";
import { type ExecFileException, execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installOrigin, installScript, requestOrigin, shQuote } from "../lib/relay/install-script";

test("origin: RELAY_PUBLIC_URL's origin wins, else the request's", () => {
  assert.equal(installOrigin({ publicUrl: "https://relay.acme.com/api/relay/", requestUrl: "http://10.0.0.5:3000/install.sh" }), "https://relay.acme.com");
  assert.equal(installOrigin({ publicUrl: "http://127.0.0.1:3000", requestUrl: "http://localhost:3000/install.sh" }), "http://127.0.0.1:3000");
  assert.equal(installOrigin({ publicUrl: undefined, requestUrl: "http://10.0.0.5:3000/install.sh?x=1" }), "http://10.0.0.5:3000");
  assert.equal(installOrigin({ publicUrl: "", requestUrl: "http://[::1]:3000/install.sh" }), "http://[::1]:3000");
  assert.equal(installOrigin({ publicUrl: "not a url", requestUrl: "https://relay_1.internal/install.sh" }), "https://relay_1.internal");
  assert.equal(installOrigin({ publicUrl: "ftp://relay.acme.com", requestUrl: "http://relay.acme.com:8080/install.sh" }), "http://relay.acme.com:8080");
  assert.equal(installOrigin({ publicUrl: "https://user:pw@relay.acme.com", requestUrl: "http://a.example/install.sh" }), "http://a.example");
});

test("request origin: the Host the client used (Next's request.url carries its own --hostname and --port)", () => {
  const url = "http://127.0.0.1:3000/install.sh";
  assert.equal(requestOrigin({ url }), "http://127.0.0.1:3000");
  assert.equal(requestOrigin({ url, host: "10.0.0.5:3000" }), "http://10.0.0.5:3000");
  assert.equal(requestOrigin({ url: "http://0.0.0.0:3000/install.sh", host: "relay-backend:3000", forwardedHost: "relay.acme.com, proxy.internal", forwardedProto: "https,http" }), "https://relay.acme.com");
  assert.equal(requestOrigin({ url, host: "relay.lan", forwardedProto: "gopher" }), "http://relay.lan", "only http or https");
  assert.equal(installOrigin({ requestUrl: requestOrigin({ url, host: "a$(id).example" }) }), null, "a hostile Host is still refused");
});

test("origin: a loopback RELAY_PUBLIC_URL is only used for loopback requests", () => {
  const publicUrl = "http://127.0.0.1:3000";
  assert.equal(installOrigin({ publicUrl, requestUrl: "http://10.0.0.5:3000/install.sh" }), "http://10.0.0.5:3000", "a teammate on the LAN");
  assert.equal(installOrigin({ publicUrl, requestUrl: "https://relay.acme.com/install.sh" }), "https://relay.acme.com", "behind a proxy");
  for (const requestUrl of ["http://localhost:3000/install.sh", "http://127.0.0.1:3000/install.sh", "http://[::1]:3000/install.sh", "http://app.localhost:3000/install.sh"]) {
    assert.equal(installOrigin({ publicUrl, requestUrl }), publicUrl, requestUrl);
  }
  assert.equal(installOrigin({ publicUrl: "http://localhost:3000", requestUrl: "http://relay.lan/install.sh" }), "http://relay.lan");
  assert.equal(installOrigin({ publicUrl: "https://relay.acme.com", requestUrl: "http://127.0.0.1:3000/install.sh" }), "https://relay.acme.com", "a public one always wins");
  assert.equal(installOrigin({ publicUrl, requestUrl: "http://a$(id).example/install.sh" }), publicUrl, "a hostile Host never replaces it");
});

test("origin: a Host header with shell or quote characters is refused, never used", () => {
  for (const host of ["a$(id).example", "a'b.example", "a`id`.example", "a;b.example", 'a"b.example', "a!b.example", "a&b.example", "a(b).example"]) {
    assert.equal(installOrigin({ requestUrl: `http://${host}/install.sh` }), null, host);
  }
  assert.equal(installOrigin({ requestUrl: "not a url" }), null);
});

test("quoting: single quotes, nothing expands", () => {
  assert.equal(shQuote("http://127.0.0.1:3000"), "'http://127.0.0.1:3000'");
  assert.equal(shQuote("it's $(x)"), `'it'\\''s $(x)'`);
  const tricky = "it's $(echo no) `echo no` $HOME \\ \"x\"";
  const out = spawnSync("sh", ["-c", `printf %s ${shQuote(tricky)}`], { encoding: "utf8" });
  assert.equal(out.stdout, tricky);
});

test("script: the relay address is the quoted default; unknown means RELAY_URL is required", () => {
  const script = installScript({ relayUrl: "http://127.0.0.1:3000" });
  assert.ok(script.startsWith("#!/bin/sh\n"));
  assert.match(script, /^set -eu$/m);
  assert.match(script, /^default_relay_url='http:\/\/127\.0\.0\.1:3000'$/m);
  assert.ok(script.includes("#   curl -fsSL http://127.0.0.1:3000/install | sh"));
  assert.ok(script.trimEnd().endsWith('main "$@"'), "nothing runs until the whole script has arrived");
  assert.doesNotMatch(script, /@@[A-Z_]+@@/);

  const unknown = installScript({ relayUrl: null });
  assert.match(unknown, /^default_relay_url=''$/m);
  assert.ok(unknown.includes("curl -fsSL <relay URL>/install | sh"));
  // Even a hostile value that slipped past installOrigin is dropped.
  assert.match(installScript({ relayUrl: "http://a$(reboot).example" }), /^default_relay_url=''$/m);
  assert.match(installScript({ relayUrl: "https://relay.acme.com/some/path?q" }), /^default_relay_url='https:\/\/relay\.acme\.com'$/m);
});

const shells = ["sh", "bash", "zsh", "dash"].filter((sh) => spawnSync("sh", ["-c", `command -v ${sh}`]).status === 0);

test("script: every available shell parses it", () => {
  assert.ok(shells.includes("sh"));
  const script = installScript({ relayUrl: "http://127.0.0.1:3000" });
  for (const sh of shells) {
    const r = spawnSync(sh, ["-n"], { input: script, encoding: "utf8" });
    assert.equal(r.status, 0, `${sh} -n: ${r.stderr}`);
  }
});

// --- Full runs -----------------------------------------------------------------------------------

const STUB = `#!/usr/bin/env node
// Keyless Relay CLI (test stub)
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("relay 9.9.9-test");
} else {
  fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ args, relayHome: process.env.RELAY_HOME }) + "\\n");
}
`;

type Files = Record<string, string | Buffer>;
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const stubFiles = (): Files => ({ "/cli/relay.mjs": STUB, "/cli/relay.mjs.sha256": `${sha(STUB)}\n` });

async function withServer(fn: (url: string, files: Files) => Promise<void>) {
  const files: Files = stubFiles();
  const server = http.createServer((req, res) => {
    const body = files[new URL(req.url ?? "/", "http://x").pathname];
    if (body === undefined) {
      res.writeHead(404, { "content-type": "text/html" }).end("<!doctype html><h1>404</h1>");
      return;
    }
    res.writeHead(200).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, files);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

type Run = { code: number; stdout: string; stderr: string; home: string; log: () => { args: string[]; relayHome: string }[] };

/** Runs the installer (piped on stdin, like curl … | sh) in a fresh temporary HOME. */
function install(relayUrl: string, opts: { shell?: string; env?: Record<string, string>; home?: string; pathPrefix?: string[] } = {}): Promise<Run> {
  const home = opts.home ?? fs.mkdtempSync(path.join(os.tmpdir(), "relay-install-test-"));
  const logFile = path.join(home, "stub.log");
  const env = {
    PATH: [...(opts.pathPrefix ?? []), path.dirname(process.execPath), process.env.PATH ?? ""].join(path.delimiter),
    HOME: home,
    RELAY_HOME: path.join(home, ".relay"),
    STUB_LOG: logFile,
    ...opts.env,
  } as unknown as NodeJS.ProcessEnv;
  return new Promise((resolve) => {
    // Async: the HTTP server answering the script runs in this process.
    const child = execFile(opts.shell ?? "sh", [], { env, encoding: "utf8", timeout: 60_000 }, (err: ExecFileException | null, stdout: string, stderr: string) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
      resolve({ code, stdout, stderr, home, log });
    });
    child.stdin!.end(installScript({ relayUrl }));
  });
}

const paths = (home: string) => ({
  target: path.join(home, ".local", "share", "relay", "relay.mjs"),
  installJson: path.join(home, ".local", "share", "relay", "install.json"),
  link: path.join(home, ".local", "bin", "relay"),
  bin: path.join(home, ".local", "bin"),
});

test("install: every shell installs the checked file, links it, and points the CLI at the relay", async () => {
  await withServer(async (url) => {
    for (const shell of shells) {
      const r = await install(url, { shell });
      assert.equal(r.code, 0, `${shell}: ${r.stderr}`);
      const p = paths(r.home);
      assert.equal(fs.readFileSync(p.target, "utf8"), STUB, shell);
      assert.equal(fs.statSync(p.target).mode & 0o777, 0o755, shell);
      assert.ok(fs.lstatSync(p.link).isSymbolicLink(), shell);
      assert.equal(fs.readlinkSync(p.link), p.target, shell);
      assert.deepEqual(JSON.parse(fs.readFileSync(p.installJson, "utf8")), { relayUrl: url }, shell);
      assert.deepEqual(r.log(), [{ args: ["config", "--relay", url, "--if-unset"], relayHome: path.join(r.home, ".relay") }], shell);
      assert.ok(!fs.existsSync(path.join(r.home, ".relay", "user.json")), "no key is made at install");
      assert.ok(r.stdout.includes("relay 9.9.9-test"), shell);
      // Not on PATH: the exact lines to add.
      assert.ok(r.stdout.includes(`${p.bin} is not on your PATH`), shell);
      assert.ok(r.stdout.includes(`echo 'export PATH="${p.bin}:$PATH"' >> ~/.zshrc`), shell);
      assert.ok(r.stdout.includes(`echo 'export PATH="${p.bin}:$PATH"' >> ~/.bashrc`), shell);
      assert.ok(r.stdout.includes(`  export PATH="${p.bin}:$PATH"`), shell);
      const tail = r.stdout.trimEnd().split("\n").slice(-4);
      assert.equal(tail[0], "Next: relay init", shell);
      assert.match(tail[1], /relay init/);
      assert.match(tail[2], /admin/);
      assert.match(tail[3], /relay login .*relay codex/);
      fs.rmSync(r.home, { recursive: true, force: true });
    }
  });
});

test("install: overrides, re-installs over an old or dangling link, and no PATH hint when it's on PATH", async () => {
  await withServer(async (url) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-install-test-"));
    const installDir = path.join(home, "opt", "relay");
    const binDir = path.join(home, "bin");
    fs.mkdirSync(binDir);
    fs.symlinkSync(path.join(home, "gone", "relay.mjs"), path.join(binDir, "relay"));
    const env = { RELAY_URL: `${url}/api/relay/`, RELAY_INSTALL_DIR: `${installDir}/`, RELAY_BIN_DIR: binDir };
    const r = await install("https://relay.example", { home, env, pathPrefix: [binDir] });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.readlinkSync(path.join(binDir, "relay")), path.join(installDir, "relay.mjs"));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(installDir, "install.json"), "utf8")), { relayUrl: url }, "RELAY_URL wins, normalized");
    assert.ok(!r.stdout.includes("is not on your PATH"));
    assert.ok(!fs.existsSync(path.join(home, ".local")), "nothing in the default folders");

    // Again, over its own link and file (an update).
    const again = await install("https://relay.example", { home, env, pathPrefix: [binDir] });
    assert.equal(again.code, 0, again.stderr);
    assert.equal(fs.readdirSync(installDir).sort().join(","), "install.json,relay.mjs", "no temporary files left");
    fs.rmSync(home, { recursive: true, force: true });
  });
});

test("install: refuses a relay command that isn't ours", async () => {
  await withServer(async (url) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-install-test-"));
    const p = paths(home);
    fs.mkdirSync(p.bin, { recursive: true });
    fs.writeFileSync(p.link, "#!/bin/sh\necho another tool\n", { mode: 0o755 });
    const file = await install(url, { home });
    assert.notEqual(file.code, 0);
    assert.match(file.stderr, /already exists and is not the Keyless Relay CLI/);
    assert.equal(fs.readFileSync(p.link, "utf8"), "#!/bin/sh\necho another tool\n");
    assert.ok(!fs.existsSync(p.target));
    assert.ok(!fs.existsSync(path.dirname(p.target)), "a refusal leaves no empty install folder");

    fs.rmSync(p.link);
    fs.symlinkSync("/bin/ls", p.link);
    const link = await install(url, { home });
    assert.notEqual(link.code, 0);
    assert.match(link.stderr, /links to another program/);
    assert.equal(fs.readlinkSync(p.link), "/bin/ls");

    // Its own earlier copy (not a link) is fine to replace.
    fs.rmSync(p.link);
    fs.writeFileSync(p.link, STUB, { mode: 0o755 });
    const ours = await install(url, { home });
    assert.equal(ours.code, 0, ours.stderr);
    assert.ok(fs.lstatSync(p.link).isSymbolicLink());
    fs.rmSync(home, { recursive: true, force: true });
  });
});

test("install: a bad checksum, a missing build or a bad RELAY_URL installs nothing", async () => {
  await withServer(async (url, files) => {
    files["/cli/relay.mjs.sha256"] = `${sha("something else")}\n`;
    const bad = await install(url);
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /checksum mismatch/);
    assert.ok(!fs.existsSync(paths(bad.home).target) && !fs.existsSync(paths(bad.home).link));

    files["/cli/relay.mjs.sha256"] = "<!doctype html>";
    const junk = await install(url);
    assert.match(junk.stderr, /is not a sha256 checksum/);

    delete files["/cli/relay.mjs"];
    const missing = await install(url);
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /relay\.mjs was not found \(404\): this relay has no CLI build\. Its operator runs npm run build:cli/);
    assert.ok(!fs.existsSync(paths(missing.home).target));

    const wrong = await install(url, { env: { RELAY_URL: "ftp://relay.example" } });
    assert.match(wrong.stderr, /RELAY_URL must be the relay's http\(s\) address.*got: ftp:\/\/relay\.example/);

    const none = await install("");
    assert.match(none.stderr, /set RELAY_URL to your relay's address/);

    // Never inside RELAY_HOME: demo:reset deletes it.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-install-test-"));
    const inHome = await install(url, { home, env: { RELAY_INSTALL_DIR: path.join(home, ".relay", "cli") } });
    assert.notEqual(inHome.code, 0);
    assert.match(inHome.stderr, /is inside RELAY_HOME/);
    const binInHome = await install(url, { home, env: { RELAY_HOME: path.join(home, "keys"), RELAY_BIN_DIR: path.join(home, "keys") } });
    assert.match(binInHome.stderr, /is inside RELAY_HOME/);
    assert.ok(!fs.existsSync(path.join(home, ".relay")) && !fs.existsSync(path.join(home, "keys")));
    for (const r of [bad, junk, missing, wrong, none, inHome]) fs.rmSync(r.home, { recursive: true, force: true });
  });
});

test("install: the two folders must be absolute, and never inside RELAY_HOME through a symlink", async () => {
  await withServer(async (url) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-install-test-"));
    for (const env of [{ RELAY_INSTALL_DIR: "relay-install" }, { RELAY_BIN_DIR: "~/bin" }] as Record<string, string>[]) {
      const r = await install(url, { home, env });
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /must be absolute paths \(got: (relay-install|~\/bin)\)/);
    }
    // RELAY_HOME is a link to data/; data/cli is inside it even though the paths don't say so.
    fs.mkdirSync(path.join(home, "data"));
    fs.symlinkSync(path.join(home, "data"), path.join(home, "keys"));
    const linked = await install(url, { home, env: { RELAY_HOME: path.join(home, "keys"), RELAY_INSTALL_DIR: path.join(home, "data", "cli") } });
    assert.notEqual(linked.code, 0);
    assert.match(linked.stderr, /is inside RELAY_HOME/);
    assert.deepEqual(fs.readdirSync(home).sort(), ["data", "keys"], "nothing was created");
    assert.deepEqual(fs.readdirSync(path.join(home, "data")), []);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

test("install: odd folder names get quoted hints, and the printed uninstall line removes only the install", async () => {
  await withServer(async (url) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-install-test-"));
    const installDir = path.join(home, "my apps", "it's relay");
    const binDir = path.join(home, "b in");
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, "keep.txt"), "not ours");
    const r = await install(url, { home, env: { RELAY_INSTALL_DIR: installDir, RELAY_BIN_DIR: binDir, ZDOTDIR: path.join(home, "zdot") } });
    assert.equal(r.code, 0, r.stderr);
    const line = (prefix: string, out = r.stdout) => out.split("\n").find((l) => l.startsWith(prefix))?.slice(prefix.length);

    // Each PATH hint, run by the shell it is for, puts the folder first.
    const exportLine = line("  export PATH=");
    assert.ok(exportLine, r.stdout);
    const shPath = spawnSync("sh", ["-c", `export PATH=${exportLine}; printf %s "$PATH"`], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv });
    assert.equal(shPath.stdout, `${binDir}:/usr/bin:/bin`);
    const zsh = line("  zsh:   ");
    assert.ok(zsh?.endsWith(` >> ${path.join(home, "zdot", ".zshrc")}`), `ZDOTDIR's .zshrc: ${zsh}`);
    assert.ok(r.stdout.includes(`  fish:  fish_add_path '${binDir}'`), r.stdout);
    const bash = line("  bash:  ")!.replace(/ >> ~\/\.bashrc .*$/, "");
    assert.equal(spawnSync("sh", ["-c", bash], { encoding: "utf8" }).stdout.trim(), `export PATH=${exportLine}`, "the echoed line is the export line");

    const uninstall = line("Uninstall: ");
    assert.ok(uninstall, r.stdout);
    const u = spawnSync("sh", ["-c", uninstall], { encoding: "utf8" });
    assert.notEqual(u.status, 0, "rmdir refuses a folder that still holds someone else's file");
    assert.ok(!fs.existsSync(path.join(binDir, "relay")) && !fs.existsSync(path.join(installDir, "relay.mjs")) && !fs.existsSync(path.join(installDir, "install.json")));
    assert.equal(fs.readFileSync(path.join(installDir, "keep.txt"), "utf8"), "not ours");
    fs.rmSync(path.join(installDir, "keep.txt"));

    const again = await install(url, { home, env: { RELAY_INSTALL_DIR: installDir, RELAY_BIN_DIR: binDir } });
    assert.equal(again.code, 0, again.stderr);
    assert.ok(line("  zsh:   ", again.stdout)?.endsWith(" >> ~/.zshrc"), "without ZDOTDIR: ~/.zshrc");
    assert.equal(spawnSync("sh", ["-c", line("Uninstall: ", again.stdout)!]).status, 0);
    assert.ok(!fs.existsSync(installDir), "the emptied install folder is removed");
    assert.ok(fs.existsSync(binDir), "the bin folder stays");
    fs.rmSync(home, { recursive: true, force: true });
  });
});

test("install: an https relay's downloads stay on https; plain http to another machine gets a warning", async () => {
  // A stand-in curl that records its arguments and fails like an unreachable host: nothing leaves this machine.
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fake-curl-"));
  const log = path.join(fake, "args");
  fs.writeFileSync(path.join(fake, "curl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 6\n`, { mode: 0o755 });
  const run = (relayUrl: string) => install(relayUrl, { pathPrefix: [fake] });

  const https = await run("https://relay.example");
  assert.notEqual(https.code, 0);
  assert.match(https.stderr, /could not download https:\/\/relay\.example\/cli\/relay\.mjs/);
  assert.match(fs.readFileSync(log, "utf8"), /--proto =https --proto-redir =https /);
  assert.doesNotMatch(https.stderr, /plain http/);

  const remote = await run("http://relay.example");
  assert.match(remote.stderr, /http:\/\/relay\.example is plain http to another machine/);
  assert.match(fs.readFileSync(log, "utf8").trim().split("\n").at(-1)!, /--proto =http,https --proto-redir =http,https /);
  for (const local of ["http://127.0.0.1:3000", "http://localhost:3000", "http://[::1]:3000", "http://app.localhost"]) {
    const r = await run(local);
    assert.doesNotMatch(r.stderr, /plain http/, local);
    fs.rmSync(r.home, { recursive: true, force: true });
  }
  const tricky = await run("http://127.0.0.1.relay.example");
  assert.match(tricky.stderr, /plain http to another machine/, "a name that only starts like a loopback address");
  for (const r of [https, remote, tricky]) fs.rmSync(r.home, { recursive: true, force: true });
  fs.rmSync(fake, { recursive: true, force: true });
});

test("install: Node.js older than 20 is refused with a link to nodejs.org", async () => {
  await withServer(async (url) => {
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fake-node-"));
    fs.writeFileSync(path.join(fake, "node"), '#!/bin/sh\ncase "$*" in *split*) echo 18 ;; *) echo 18.19.0 ;; esac\n', { mode: 0o755 });
    const r = await install(url, { pathPrefix: [fake] });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /relay needs Node\.js 20 or newer, and this is Node\.js 18\.19\.0\. Update it from https:\/\/nodejs\.org/);
    fs.rmSync(fake, { recursive: true, force: true });
    fs.rmSync(r.home, { recursive: true, force: true });
  });
});
