// The user CLI's two modes (scripts/lib/cli-mode.ts): installed (`relay`, the esbuild bundle) and
// repo (`./relay`, tsx): command names, the Codex templates, the workspace and its checks, what Codex
// trusts, how Codex finds `relay`, config.json merging, and the broadcast RPC list.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BUNDLED,
  EMBEDDED_TEMPLATES,
  EMBEDDED_VERSION,
  MODE,
  TEMPLATE_FILES,
  codexPath,
  commandName,
  installCommand,
  isGeneratedFile,
  mergeConfig,
  physicalPath,
  projectsTrust,
  renderTemplate,
  symlinkOnTheWay,
  trustedDirs,
  versionLine,
  workspaceDir,
  workspaceProblem,
  workspaceTargets,
} from "../scripts/lib/cli-mode";
import { BROADCAST_FALLBACK_RPCS, DEFAULT_RPC_URL, TENDERLY_RPC_URL, broadcastRpcs } from "../scripts/lib/ensv2";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = (key: keyof typeof TEMPLATE_FILES) => fs.readFileSync(path.join(REPO, "scripts", "templates", TEMPLATE_FILES[key]), "utf8");
const vars = (cmd: string) => ({ agent: "codex.derek.dev.eng.acme.eth", user: "derek.dev.eng.acme.eth", relay: "http://127.0.0.1:3000", cmd });

test("mode: tsx runs the source, so nothing is embedded", () => {
  assert.equal(BUNDLED, false);
  assert.equal(MODE, "repo");
  assert.equal(EMBEDDED_VERSION, null);
  assert.equal(EMBEDDED_TEMPLATES, null);
});

test("command name: relay once installed, ./relay from the repo", () => {
  assert.equal(commandName("installed"), "relay");
  assert.equal(commandName("repo"), "./relay");
  assert.equal(versionLine("installed", "0.1.0+abc1234"), "relay 0.1.0+abc1234");
  assert.match(versionLine("repo", "0.1.0"), /^\.\/relay 0\.1\.0 /);
  assert.equal(versionLine("installed", null), "relay unknown");
  assert.equal(installCommand("https://relay.example"), "curl -fsSL https://relay.example/install.sh | sh");
});

test("templates: every placeholder is filled, with the mode's command", () => {
  for (const key of ["agents", "skill"] as const) {
    const raw = template(key);
    assert.match(raw, /\{\{CMD\}\}/, `${TEMPLATE_FILES[key]} names the command through {{CMD}}`);
    assert.doesNotMatch(raw, /\.\/relay/, `${TEMPLATE_FILES[key]} has no hard-coded ./relay`);

    const installed = renderTemplate(raw, vars("relay"));
    assert.doesNotMatch(installed, /\{\{[A-Z]+\}\}/);
    assert.doesNotMatch(installed, /\.\/relay/);
    assert.ok(installed.includes("codex.derek.dev.eng.acme.eth"));
    assert.ok(isGeneratedFile(installed), "the installed rendering is recognised as ours");

    const repo = renderTemplate(raw, vars("./relay"));
    assert.doesNotMatch(repo, /\{\{[A-Z]+\}\}/);
    assert.ok(isGeneratedFile(repo));
  }
  const skill = renderTemplate(template("skill"), vars("relay"));
  assert.ok(skill.includes("\nrelay subagent create research --codex 1 --minutes 20\n"));
  assert.ok(skill.includes('\nrelay exec --as research "'));
  assert.ok(skill.includes("\nrelay image --as image --prompt"));
  assert.ok(renderTemplate(template("skill"), vars("./relay")).includes("\n./relay subagent create image --images 1 --minutes 20\n"));
  assert.ok(renderTemplate(template("agents"), vars("relay")).includes("through Keyless Relay (http://127.0.0.1:3000)"));
});

test("templates: the repo's demo-workspace copies are ours, rendered for ./relay", () => {
  // `./relay codex` rewrites them with the real names during a demo, so only their shape is checked.
  const ws = path.join(REPO, "demo-workspace");
  const targets = workspaceTargets(ws);
  assert.equal(targets.agents, path.join(ws, "AGENTS.md"));
  assert.equal(targets.skill, path.join(ws, ".agents", "skills", "ens-subagents", "SKILL.md"));
  for (const key of ["agents", "skill"] as const) {
    const text = fs.readFileSync(targets[key], "utf8");
    assert.ok(isGeneratedFile(text), `${targets[key]} carries the generated header`);
    assert.doesNotMatch(text, /\{\{[A-Z]+\}\}/);
  }
  assert.match(fs.readFileSync(targets.skill, "utf8"), /^\.\/relay subagent create research /m);
});

test("generated files: ours (old and new headers) may be replaced, a project's own are not", () => {
  assert.ok(isGeneratedFile("<!-- Written by ./relay codex from scripts/templates/AGENTS.md; edits here are overwritten. -->\n"));
  assert.ok(isGeneratedFile("<!-- Written by relay codex; edits here are overwritten. -->\n"));
  assert.ok(isGeneratedFile("---\nname: ens-subagents\n---\n\n<!-- Written by relay codex; edits here are overwritten. -->\n"));
  assert.ok(!isGeneratedFile("# My project\n\nUse pnpm.\n"));
  assert.ok(!isGeneratedFile("<!-- Written by relay codexx -->"));
});

test("workspace: repo mode keeps demo-workspace/, installed mode uses RELAY_WORKSPACE or the current folder", () => {
  assert.equal(workspaceDir({ mode: "repo", repoRoot: "/r", env: { RELAY_WORKSPACE: "/elsewhere" }, cwd: "/tmp/x" }), path.join("/r", "demo-workspace"));
  assert.equal(workspaceDir({ mode: "installed", repoRoot: "/r", env: {}, cwd: "/work/proj" }), "/work/proj");
  assert.equal(workspaceDir({ mode: "installed", repoRoot: "/r", env: { RELAY_WORKSPACE: "  " }, cwd: "/work/proj" }), "/work/proj");
  assert.equal(workspaceDir({ mode: "installed", repoRoot: "/r", env: { RELAY_WORKSPACE: "/ws" }, cwd: "/work/proj" }), "/ws");
  assert.equal(workspaceDir({ mode: "installed", repoRoot: "/r", env: { RELAY_WORKSPACE: "demo" }, cwd: "/work/proj" }), "/work/proj/demo");
});

test("workspace: never the home folder, /, or anything overlapping RELAY_HOME", () => {
  const check = (workspace: string, relayHome = "/home/u/.relay") => workspaceProblem({ workspace, home: "/home/u", relayHome, cmd: "relay" });
  assert.equal(check("/home/u/proj"), null);
  assert.equal(check("/tmp/demo"), null);
  assert.equal(check("/home/u/..relay-notes"), null, "a sibling whose name starts with .. is not inside");
  assert.match(check("/home/u")!, /whole home folder/);
  assert.match(check("/home/u/")!, /whole home folder/);
  assert.match(check("/")!, /write access to \//);
  assert.match(check("/home")!, /overlaps RELAY_HOME/, "a parent of the home folder contains ~/.relay");
  assert.match(check("/home", "/opt/relay-home")!, /whole home folder \(\/home\/u is inside \/home\)/, "a parent of the home folder, RELAY_HOME elsewhere");
  assert.equal(check("/home/other", "/opt/relay-home"), null, "a sibling of the home folder is fine");
  assert.match(check("/home/u/.relay")!, /overlaps RELAY_HOME/);
  assert.match(check("/home/u/.relay/agents")!, /overlaps RELAY_HOME/);
  assert.match(check("/work/proj", "/work/proj/.relay")!, /overlaps RELAY_HOME/);
  assert.match(check("/home/u")!, /relay codex` in a project folder/);
});

test("workspace: symlinks are resolved before comparing (HOME through a link, a link to the home folder)", () => {
  // /home -> /data/home, and /work/link -> /data/home/u; process.cwd() is always physical.
  const realpath = (p: string): string | null => {
    const links: [string, string][] = [["/home", "/data/home"], ["/work/link", "/data/home/u"]];
    for (const [from, to] of links) if (p === from || p.startsWith(`${from}/`)) p = to + p.slice(from.length);
    return ["/", "/data", "/data/home", "/data/home/u", "/data/home/u/.relay", "/data/home/u/proj", "/work", "/tmp"].includes(p) ? p : null;
  };
  assert.equal(physicalPath("/home/u", realpath), "/data/home/u");
  assert.equal(physicalPath("/home/u/new/deeper", realpath), "/data/home/u/new/deeper", "a folder that doesn't exist yet: its nearest existing ancestor");
  assert.equal(physicalPath("/nowhere/x", realpath), "/nowhere/x");
  const check = (workspace: string, relayHome = "/home/u/.relay") => workspaceProblem({ workspace, home: "/home/u", relayHome, cmd: "relay", realpath });
  assert.equal(workspaceProblem({ workspace: "/data/home/u", home: "/home/u", relayHome: "/home/u/.relay", cmd: "relay" }), null, "without realpath the link hides it");
  assert.match(check("/data/home/u")!, /whole home folder/, "cd ~ gives the physical path");
  assert.match(check("/work/link")!, /whole home folder/, "RELAY_WORKSPACE through a link to the home folder");
  assert.match(check("/data/home/u/.relay/agents")!, /overlaps RELAY_HOME/);
  assert.match(check("/data", "/opt/keys")!, /is inside \/data/, "a folder above the physical home folder");
  assert.equal(check("/data/home/u/proj"), null);
  assert.equal(check("/tmp/demo"), null);
});

test("workspace files: never written through a symlink", () => {
  const kinds: Record<string, "link" | "other"> = { "/w": "other", "/w/AGENTS.md": "link", "/v": "other", "/v/.agents": "link", "/x": "other", "/x/.agents": "other" };
  const kind = (p: string) => kinds[p] ?? null;
  assert.equal(symlinkOnTheWay("/w", "/w/AGENTS.md", kind), "/w/AGENTS.md", "a (dangling) AGENTS.md link");
  assert.equal(symlinkOnTheWay("/v", "/v/.agents/skills/ens-subagents/SKILL.md", kind), "/v/.agents", "a linked .agents folder");
  assert.equal(symlinkOnTheWay("/x", "/x/.agents/skills/ens-subagents/SKILL.md", kind), null, "real folders, the rest not there yet");
  assert.equal(symlinkOnTheWay("/x", "/x/AGENTS.md", kind), null);
  assert.equal(symlinkOnTheWay("/x", "/elsewhere/AGENTS.md", kind), "/elsewhere/AGENTS.md", "outside the workspace is refused too");
});

test("trust: installed mode trusts only a workspace without its own .codex/; the repo also trusts the repo", () => {
  assert.deepEqual(trustedDirs({ mode: "installed", workspace: "/w", repoRoot: "/meaningless", hasProjectConfig: false }), ["/w"]);
  assert.deepEqual(trustedDirs({ mode: "installed", workspace: "/w", repoRoot: "/meaningless", hasProjectConfig: true }), [], "Codex asks");
  assert.deepEqual(trustedDirs({ mode: "repo", workspace: "/r/demo-workspace", repoRoot: "/r", hasProjectConfig: true }), ["/r/demo-workspace", "/r"]);
  assert.equal(projectsTrust(["/w"]), 'projects={"/w"={trust_level="trusted"}}');
  assert.equal(projectsTrust(["/a b", "/r", "/r"]), 'projects={"/a b"={trust_level="trusted"}, "/r"={trust_level="trusted"}}');
  assert.equal(projectsTrust(['/q"x']), 'projects={"/q\\"x"={trust_level="trusted"}}');
});

test("codex PATH: unchanged when relay already resolves here, else the link's folder or RELAY_HOME/bin goes first", () => {
  const self = "/home/u/.local/share/relay/relay.mjs";
  const links: Record<string, string> = {
    "/home/u/.local/bin/relay": self,
    "/usr/local/bin/relay": "/usr/local/lib/other-relay",
    "/home/u/.relay/bin/relay": self,
  };
  const realpath = (p: string) => (p === self ? self : (links[p] ?? null));
  const base = { self, fallbackDir: "/home/u/.relay/bin", realpath };

  // `relay` on PATH is this file.
  assert.deepEqual(codexPath({ ...base, pathEnv: "/usr/bin:/home/u/.local/bin", argv1: "/home/u/.local/bin/relay" }), {
    pathEnv: "/usr/bin:/home/u/.local/bin",
    link: null,
  });
  // Started as ~/.local/bin/relay, which isn't on PATH: its folder goes first.
  assert.deepEqual(codexPath({ ...base, pathEnv: "/usr/bin:/bin", argv1: "/home/u/.local/bin/relay" }), {
    pathEnv: "/home/u/.local/bin:/usr/bin:/bin",
    link: null,
  });
  // Another relay comes first on PATH: ours goes before it (and isn't listed twice).
  assert.deepEqual(codexPath({ ...base, pathEnv: "/usr/local/bin:/home/u/.local/bin", argv1: "/home/u/.local/bin/relay" }), {
    pathEnv: "/home/u/.local/bin:/usr/local/bin",
    link: null,
  });
  // Started as node relay.mjs: a link in RELAY_HOME/bin.
  assert.deepEqual(codexPath({ ...base, pathEnv: "/usr/bin", argv1: self }), { pathEnv: "/home/u/.relay/bin:/usr/bin", link: "/home/u/.relay/bin/relay" });
  assert.deepEqual(codexPath({ ...base, pathEnv: "", argv1: undefined }), { pathEnv: "/home/u/.relay/bin", link: "/home/u/.relay/bin/relay" });
  // A `relay` that isn't this file doesn't count as the link we were started through.
  assert.equal(codexPath({ ...base, pathEnv: "/usr/bin", argv1: "/usr/local/bin/relay" }).link, "/home/u/.relay/bin/relay");
});

test("config.json: merges settings and keeps every other field; --if-unset keeps a saved relay", () => {
  const current = { relayUrl: "https://a.example", rpcUrl: "https://rpc.example", extra: { keep: true } };
  assert.deepEqual(mergeConfig(current, { relayUrl: "https://b.example" }), {
    config: { relayUrl: "https://b.example", rpcUrl: "https://rpc.example", extra: { keep: true } },
    changed: ["relayUrl"],
    kept: [],
  });
  assert.deepEqual(mergeConfig(current, { relayUrl: "https://b.example" }, { ifUnset: true }), { config: current, changed: [], kept: ["relayUrl"] });
  assert.deepEqual(mergeConfig(current, { relayUrl: "https://a.example" }, { ifUnset: true }), { config: current, changed: [], kept: [] });
  assert.deepEqual(mergeConfig({ rpcUrl: "https://rpc.example" }, { relayUrl: "https://b.example" }, { ifUnset: true }), {
    config: { rpcUrl: "https://rpc.example", relayUrl: "https://b.example" },
    changed: ["relayUrl"],
    kept: [],
  });
  assert.deepEqual(mergeConfig({ relayUrl: "  " }, { relayUrl: "https://b.example" }, { ifUnset: true }).changed, ["relayUrl"], "a blank value counts as unset");
  assert.deepEqual(mergeConfig(null, { relayUrl: "https://b.example", rpcUrl: undefined }).config, { relayUrl: "https://b.example" });
  assert.deepEqual(mergeConfig([1, 2], { relayUrl: "https://b.example" }).config, { relayUrl: "https://b.example" }, "a broken file starts over");
  assert.deepEqual(current, { relayUrl: "https://a.example", rpcUrl: "https://rpc.example", extra: { keep: true } }, "the input is not mutated");
  const valid = (key: string, value: string) => key !== "relayUrl" || /^https?:\/\//.test(value);
  assert.deepEqual(mergeConfig({ relayUrl: "not a url" }, { relayUrl: "https://b.example" }, { ifUnset: true, valid }).changed, ["relayUrl"], "a broken value counts as unset");
  assert.deepEqual(mergeConfig(current, { relayUrl: "https://b.example" }, { ifUnset: true, valid }).kept, ["relayUrl"], "a valid one is kept");
});

test("RPCs: the CLI defaults to Tenderly; broadcast fallbacks never repeat the primary", () => {
  assert.equal(TENDERLY_RPC_URL, "https://sepolia.gateway.tenderly.co");
  assert.deepEqual(BROADCAST_FALLBACK_RPCS, [TENDERLY_RPC_URL, DEFAULT_RPC_URL]);
  assert.deepEqual(broadcastRpcs(TENDERLY_RPC_URL), [TENDERLY_RPC_URL, DEFAULT_RPC_URL]);
  assert.deepEqual(broadcastRpcs("https://sepolia.gateway.tenderly.co/"), ["https://sepolia.gateway.tenderly.co/", DEFAULT_RPC_URL]);
  assert.deepEqual(broadcastRpcs("https://eth-sepolia.g.alchemy.com/v2/k"), ["https://eth-sepolia.g.alchemy.com/v2/k", TENDERLY_RPC_URL, DEFAULT_RPC_URL]);
  assert.deepEqual(broadcastRpcs(DEFAULT_RPC_URL.toUpperCase()), [DEFAULT_RPC_URL.toUpperCase(), TENDERLY_RPC_URL]);
});
