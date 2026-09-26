// How the user CLI (scripts/relay.ts) is running, and the pure helpers that differ by mode:
//
// - repo:      tsx runs the source from this repo (`./relay`, `demo-workspace/relay`, `npm run relay`).
//              It reads the repo's .env.local and scripts/templates/, and Codex works in demo-workspace/.
// - installed: the esbuild bundle (npm run build:cli → public/cli/relay.mjs) that <relay>/install.sh
//              puts on PATH as `relay`. Templates and version are embedded; there is no repo to read,
//              and Codex works in the current folder (or RELAY_WORKSPACE).
//
// Nothing here touches the file system or the environment on import, so tests cover both modes.

import path from "node:path";

// Replaced by scripts/build-cli.mjs (esbuild `define`); never defined when tsx runs the source.
declare const __RELAY_BUNDLED__: boolean | undefined;
declare const __RELAY_VERSION__: string | undefined;
declare const __RELAY_TEMPLATE_AGENTS__: string | undefined;
declare const __RELAY_TEMPLATE_SKILL__: string | undefined;

export type CliMode = "installed" | "repo";
export type Templates = { agents: string; skill: string };

export const BUNDLED: boolean = typeof __RELAY_BUNDLED__ !== "undefined" && __RELAY_BUNDLED__ === true;
export const MODE: CliMode = BUNDLED ? "installed" : "repo";
/** "0.1.0+dbc73ac" in the bundle, null from source. */
export const EMBEDDED_VERSION: string | null = BUNDLED && typeof __RELAY_VERSION__ === "string" ? __RELAY_VERSION__ : null;
/** scripts/templates/*.md as they were at build time, null from source. */
export const EMBEDDED_TEMPLATES: Templates | null = BUNDLED
  ? { agents: typeof __RELAY_TEMPLATE_AGENTS__ === "string" ? __RELAY_TEMPLATE_AGENTS__ : "", skill: typeof __RELAY_TEMPLATE_SKILL__ === "string" ? __RELAY_TEMPLATE_SKILL__ : "" }
  : null;

/** What the user types: `relay` once installed, `./relay` from the repo. */
export const commandName = (mode: CliMode) => (mode === "installed" ? "relay" : "./relay");

/** The one-line installer for a relay (served by app/install.sh/route.ts). */
export const installCommand = (relayUrl: string) => `curl -fsSL ${relayUrl}/install.sh | sh`;

export function versionLine(mode: CliMode, version: string | null): string {
  return mode === "installed" ? `relay ${version ?? "unknown"}` : `./relay ${version ?? "unknown"} (repo: scripts/relay.ts)`;
}

// --- Templates (AGENTS.md and the ens-subagents skill Codex gets) ------------------------

/** The template files in scripts/templates/, by key. */
export const TEMPLATE_FILES: Record<keyof Templates, string> = { agents: "AGENTS.md", skill: "SKILL.md" };

/** Where each template goes in the workspace. */
export const workspaceTargets = (workspace: string): Record<keyof Templates, string> => ({
  agents: path.join(workspace, "AGENTS.md"),
  skill: path.join(workspace, ".agents", "skills", "ens-subagents", "SKILL.md"),
});

export type TemplateVars = { agent: string; user: string; relay: string; cmd: string };

/** Fills {{AGENT}}, {{USER}}, {{RELAY}} (the relay URL) and {{CMD}} (`relay` or `./relay`). */
export const renderTemplate = (text: string, v: TemplateVars) =>
  text.replaceAll("{{AGENT}}", v.agent).replaceAll("{{USER}}", v.user).replaceAll("{{RELAY}}", v.relay).replaceAll("{{CMD}}", v.cmd);

/** True for a file `relay codex` wrote (it may replace it); anything else in the workspace is the user's. */
export const isGeneratedFile = (text: string) => /<!-- Written by (\.\/)?relay codex\b/.test(text);

// --- The folder Codex works in ------------------------------------------------------------

/** Installed: RELAY_WORKSPACE, else the current folder. Repo: <repo>/demo-workspace, as always. */
export function workspaceDir(o: { mode: CliMode; repoRoot: string; env: Record<string, string | undefined>; cwd: string }): string {
  if (o.mode === "repo") return path.join(o.repoRoot, "demo-workspace");
  const fromEnv = o.env.RELAY_WORKSPACE?.trim();
  return path.resolve(o.cwd, fromEnv || ".");
}

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === "" || (rel.split(path.sep)[0] !== ".." && !path.isAbsolute(rel));
};

/**
 * `p` with every symlink resolved, also when it doesn't exist yet: the real path of its nearest
 * existing ancestor plus the rest. `realpath` returns null for a path that doesn't exist.
 */
export function physicalPath(p: string, realpath: (p: string) => string | null): string {
  const rest: string[] = [];
  for (let dir = path.resolve(p); ; ) {
    const real = realpath(dir);
    if (real !== null) return path.join(real, ...rest.reverse());
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(p);
    rest.push(path.basename(dir));
    dir = parent;
  }
}

/**
 * Why Codex must not work in `workspace` (null when it may). Codex can write the whole workspace,
 * so it can't be /, the home folder or a folder above it, and it must not contain RELAY_HOME (the
 * user's key) or sit inside it. With `realpath`, the paths are also compared with their symlinks
 * resolved (process.cwd() is already physical while HOME may go through a link, e.g. /home -> /data/home).
 */
export function workspaceProblem(o: {
  workspace: string;
  home: string;
  relayHome: string;
  cmd: string;
  realpath?: (p: string) => string | null;
}): string | null {
  const fix = `Run \`${o.cmd} codex\` in a project folder (for example: mkdir -p ~/relay-demo && cd ~/relay-demo), or set RELAY_WORKSPACE.`;
  const views: ((p: string) => string)[] = [(p) => path.resolve(p)];
  const { realpath } = o;
  if (realpath) views.push((p) => physicalPath(p, realpath));
  for (const view of views) {
    const ws = view(o.workspace);
    const home = view(o.home);
    const relayHome = view(o.relayHome);
    if (ws === path.parse(ws).root) return `Codex would get write access to ${ws}. ${fix}`;
    if (ws === home) return `Codex would get write access to your whole home folder (${ws}). ${fix}`;
    if (inside(relayHome, ws) || inside(ws, relayHome)) {
      return `The workspace ${ws} overlaps RELAY_HOME (${relayHome}), where your key is; Codex could change it. ${fix}`;
    }
    // Checked after RELAY_HOME, which usually sits in the home folder and is the sharper reason.
    if (inside(home, ws)) return `Codex would get write access to your whole home folder (${home} is inside ${ws}). ${fix}`;
  }
  return null;
}

/**
 * Folders Codex trusts for an interactive run (in memory, for this run only), so it doesn't ask. Trust
 * lets Codex load a folder's own .codex/ (project config, hooks, exec policies), so the installed CLI,
 * which runs in any folder, trusts the workspace only while it has no .codex of its own; otherwise
 * Codex asks, as it does for any folder. The repo trusts demo-workspace/ and itself (the operator's).
 */
export const trustedDirs = (o: { mode: CliMode; workspace: string; repoRoot: string; hasProjectConfig: boolean }) =>
  o.mode === "repo" ? [o.workspace, o.repoRoot] : o.hasProjectConfig ? [] : [o.workspace];

/**
 * The workspace files `relay codex` may not write (null when it may): a symlink anywhere from the
 * workspace down to `target` (the file itself included) would send the write outside the workspace.
 * `lstatKind` returns "link", "other", or null when the path doesn't exist.
 */
export function symlinkOnTheWay(workspace: string, target: string, lstatKind: (p: string) => "link" | "other" | null): string | null {
  const rel = path.relative(workspace, target);
  if (!rel || rel.split(path.sep)[0] === ".." || path.isAbsolute(rel)) return target;
  let p = workspace;
  for (const part of rel.split(path.sep)) {
    p = path.join(p, part);
    const kind = lstatKind(p);
    if (kind === "link") return p;
    if (kind === null) return null; // nothing below it exists either: mkdir makes real folders
  }
  return null;
}

/** Codex's `-c projects={…}` value marking `dirs` trusted (in memory, for this run only). */
export const projectsTrust = (dirs: string[]) => `projects={${[...new Set(dirs)].map((d) => `${JSON.stringify(d)}={trust_level="trusted"}`).join(", ")}}`;

/**
 * How Codex (installed mode) finds `relay`: its shell inherits PATH. When the first `relay` on PATH
 * is already this file nothing changes; otherwise the folder of the `relay` link this process was
 * started through (e.g. ~/.local/bin/relay run by its full path) goes first, or else `fallbackDir`,
 * where the caller links `relay` → this file (`link`).
 */
export function codexPath(o: {
  pathEnv: string;
  argv1: string | undefined;
  /** This file's real path. */
  self: string;
  fallbackDir: string;
  /** Real path of an existing file, else null. */
  realpath: (p: string) => string | null;
}): { pathEnv: string; link: string | null } {
  const dirs = o.pathEnv.split(path.delimiter).filter(Boolean);
  const first = dirs.map((d) => o.realpath(path.join(d, "relay"))).find((p) => p !== null);
  if (first === o.self) return { pathEnv: o.pathEnv, link: null };
  const viaArgv = o.argv1 && path.basename(o.argv1) === "relay" && o.realpath(o.argv1) === o.self ? path.dirname(o.argv1) : null;
  const dir = viaArgv ?? o.fallbackDir;
  return { pathEnv: [dir, ...dirs.filter((d) => d !== dir)].join(path.delimiter), link: viaArgv ? null : path.join(o.fallbackDir, "relay") };
}

// --- config.json ----------------------------------------------------------------------------

/**
 * Merges settings into config.json's contents, keeping every other field. With `ifUnset` (the
 * installer), a value already saved is kept, unless `valid` says it is broken (e.g. a relayUrl that
 * isn't a URL), which counts as unset. Returns what changed and what was kept.
 */
export function mergeConfig(
  current: unknown,
  update: Record<string, string | undefined>,
  opts: { ifUnset?: boolean; valid?: (key: string, value: string) => boolean } = {},
): { config: Record<string, unknown>; changed: string[]; kept: string[] } {
  const base = current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
  const config: Record<string, unknown> = { ...base };
  const changed: string[] = [];
  const kept: string[] = [];
  for (const [key, value] of Object.entries(update)) {
    if (value === undefined) continue;
    const had = base[key];
    if (had === value) continue;
    if (opts.ifUnset && typeof had === "string" && had.trim() && (opts.valid?.(key, had) ?? true)) {
      kept.push(key);
      continue;
    }
    config[key] = value;
    changed.push(key);
  }
  return { config, changed, kept };
}
