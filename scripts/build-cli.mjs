// npm run build:cli: bundles the user CLI (scripts/relay.ts, viem and all) into one Node.js file,
// public/cli/relay.mjs, plus public/cli/relay.mjs.sha256. The relay serves both, and its
// /install.sh (app/install.sh/route.ts) installs the file as the `relay` command.
// Runs before `next dev` and `next build` (the predev and prebuild scripts).
//
// The bundle knows it is installed through esbuild `define`s (scripts/lib/cli-mode.ts): a bundled
// flag, the version (package.json + short git sha, "-dirty" with uncommitted changes) and the Codex
// templates in scripts/templates/.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const started = Date.now();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "public", "cli");
const outFile = path.join(outDir, "relay.mjs");

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const git = (...args) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
let sha = "";
try {
  sha = git("rev-parse", "--short", "HEAD");
  // Uncommitted changes (like git describe --dirty): the commit alone doesn't say what was built.
  if (git("status", "--porcelain", "--untracked-files=normal")) sha += "-dirty";
} catch {}
const version = sha ? `${pkg.version}+${sha}` : pkg.version;
const template = (name) => fs.readFileSync(path.join(root, "scripts", "templates", name), "utf8");

const result = await build({
  absWorkingDir: root,
  entryPoints: ["scripts/relay.ts"],
  outfile: outFile,
  write: false,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Readable stack traces; about 850 KB.
  minify: false,
  sourcemap: false,
  legalComments: "eof",
  logLevel: "warning",
  banner: {
    js: [
      "#!/usr/bin/env node",
      `// Keyless Relay CLI (relay) ${version}. Built from scripts/relay.ts by scripts/build-cli.mjs.`,
      "// Install or update: curl -fsSL <relay>/install.sh | sh",
      // For any CommonJS dependency that calls require() inside the ESM bundle.
      'import { createRequire as __relayCreateRequire } from "node:module";',
      "const require = __relayCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  define: {
    __RELAY_BUNDLED__: "true",
    __RELAY_VERSION__: JSON.stringify(version),
    __RELAY_TEMPLATE_AGENTS__: JSON.stringify(template("AGENTS.md")),
    __RELAY_TEMPLATE_SKILL__: JSON.stringify(template("SKILL.md")),
  },
});

const bytes = result.outputFiles.find((f) => f.path === outFile)?.contents;
if (!bytes) throw new Error(`esbuild produced no ${outFile}`);
const digest = createHash("sha256").update(bytes).digest("hex");

// Written next to the target and renamed, so a running relay never serves half a file or a stale checksum.
fs.mkdirSync(outDir, { recursive: true });
const write = (file, data, mode) => {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
};
write(outFile, bytes, 0o755);
write(`${outFile}.sha256`, `${digest}\n`, 0o644);

const kb = (bytes.length / 1024).toFixed(0);
console.log(`build:cli  ${path.relative(root, outFile)} ${version} · ${kb} KB · sha256 ${digest.slice(0, 12)}… · ${Date.now() - started} ms`);
