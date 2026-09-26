// The service credential store (server only).
//
// Values live encrypted in <RELAY_DATA_DIR>/credentials.json (AES-256-GCM, key
// from RELAY_SECRET; see credentials-crypto.ts), written atomically (tmp file,
// fsync, rename, mode 0600). The relay itself keeps reading keys from
// process.env (config.ts re-reads it on every request), so the store drives the
// environment: at start (instrumentation.ts) and after every write, each stored
// value is set in process.env and the original value is remembered, so clearing
// a stored key restores what the environment had.
//
// Only catalog key variables and the listed upstream overrides can be stored
// (credentials-types.ts): nothing here can change RELAY_ROOT_OWNER or any other
// setting. Values are never logged and never returned; views carry redacted
// hints for the owner and admin only.
//
// A file that can't be read or opened (damaged, or RELAY_SECRET changed) is
// never overwritten: the store reports the problem and refuses writes until the
// file is restored or moved aside.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { loadConfig } from "./config";
import { UnsealError, secretFingerprint, secretProblem, seal, unseal, usableSecret } from "./credentials-crypto";
import { type CredentialKeyView, type CredentialSlot, type CustomServiceView, UPSTREAM_SLOTS, credentialSlots, slotFor } from "./credentials-types";

type Env = Record<string, string | undefined>;

export const CREDENTIALS_FILE = "credentials.json";
export const MAX_VALUE_LENGTH = 4096;
export const MAX_CUSTOM = 50;

export type StoredKey = { value: string; updatedAt: number };
export type StoredCustom = { label: string; value: string | null; note: string | null; createdAt: number; updatedAt: number };
export type StoreData = { keys: Record<string, StoredKey>; custom: Record<string, StoredCustom> };

/** A refusal with the HTTP status the API answers with. */
export class CredentialsError extends Error {
  override name = "CredentialsError";
  constructor(
    readonly status: number,
    readonly error: string,
    readonly reason: string,
  ) {
    super(reason);
  }
}

const emptyData = (): StoreData => ({ keys: {}, custom: {} });

/**
 * record[key] only when it is the record's own entry: ids come from URLs, and "constructor"
 * passes CUSTOM_ID but would otherwise find Object.prototype.constructor.
 */
export const ownEntry = <T>(record: Record<string, T>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);

// --- Values ----------------------------------------------------------------------

const DOTS = "••••••••";

/**
 * A redacted hint: "sk-p••••••••3f2a" (a recognizable prefix's first 4
 * characters, then the last 4) for long values; "••••••••3f2a" for 12–19
 * characters; "••••2a" below 12. The dots don't reveal the length.
 */
export function redact(value: string): string {
  const v = value.trim();
  if (v.length < 12) return `••••${v.slice(-2)}`;
  if (v.length < 20) return `${DOTS}${v.slice(-4)}`;
  const prefix = /^[A-Za-z]{2,10}[-_]/.test(v) ? v.slice(0, 4) : "";
  return `${prefix}${DOTS}${v.slice(-4)}`;
}

/** Checks a secret value; returns it trimmed. Values go into HTTP headers, so whitespace and control characters are refused. */
export function checkSecretValue(raw: unknown): string {
  if (typeof raw !== "string") throw new CredentialsError(400, "bad value", "value must be a string (or null to clear)");
  const v = raw.trim();
  if (v.length > MAX_VALUE_LENGTH) throw new CredentialsError(400, "bad value", `value is longer than ${MAX_VALUE_LENGTH} characters`);
  if (!/^[\x21-\x7e]+$/.test(v)) throw new CredentialsError(400, "bad value", "value may only contain visible ASCII characters (no spaces or line breaks)");
  return v;
}

/** Mailchimp data center: "us21" or "https://us21.api.mailchimp.com" -> "https://us21.api.mailchimp.com". */
export function checkUpstreamValue(env: string, raw: unknown): string {
  if (typeof raw !== "string") throw new CredentialsError(400, "bad value", "value must be a string (or null to clear)");
  const v = raw.trim().toLowerCase();
  if (env === "RELAY_UPSTREAM_MAILCHIMP") {
    const m = v.match(/^(?:https:\/\/)?([a-z]{2}\d{1,3})(?:\.api\.mailchimp\.com\/?)?$/);
    if (m && (v === m[1] || v.includes(".api.mailchimp.com"))) return `https://${m[1]}.api.mailchimp.com`;
    throw new CredentialsError(400, "bad value", "use your Mailchimp data center, e.g. us21 or https://us21.api.mailchimp.com");
  }
  throw new CredentialsError(404, "unknown setting", `${env} can't be set here`);
}

/** A stored value for a slot, checked and normalized. */
export function checkSlotValue(slot: CredentialSlot, raw: unknown): string {
  return slot.kind === "upstream" ? checkUpstreamValue(slot.env, raw) : checkSecretValue(raw);
}

export function checkLabel(raw: unknown): string {
  const v = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!v || v.length > 60 || /[\x00-\x1f\x7f]/.test(v)) throw new CredentialsError(400, "bad label", "label must be 1–60 characters");
  return v;
}

export function checkNote(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const v = typeof raw === "string" ? raw.trim() : "";
  if (v.length > 200 || /[\x00-\x1f\x7f]/.test(v)) throw new CredentialsError(400, "bad note", "note must be at most 200 characters on one line");
  return v || null;
}

export const CUSTOM_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

const slug = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/, "") || "service";

// --- Store -----------------------------------------------------------------------------

function parseData(raw: string): StoreData {
  const parsed = JSON.parse(raw) as Partial<StoreData>;
  const data = emptyData();
  for (const [k, v] of Object.entries(parsed?.keys ?? {})) {
    if (v && typeof v.value === "string" && typeof v.updatedAt === "number") data.keys[k] = { value: v.value, updatedAt: v.updatedAt };
  }
  for (const [k, v] of Object.entries(parsed?.custom ?? {})) {
    if (!v || typeof v.label !== "string" || !CUSTOM_ID.test(k)) continue;
    data.custom[k] = {
      label: v.label,
      value: typeof v.value === "string" ? v.value : null,
      note: typeof v.note === "string" ? v.note : null,
      createdAt: typeof v.createdAt === "number" ? v.createdAt : 0,
      updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : 0,
    };
  }
  return data;
}

export class CredentialStore {
  data: StoreData = emptyData();
  /** Why the stored credentials can't be used (nothing is applied and writes are refused), or null. */
  readonly error: string | null;
  private readonly secret: string | null;
  private readonly secretIssue: string | null;

  constructor(
    readonly file: string,
    secret: string | null | undefined,
  ) {
    this.secret = usableSecret(secret);
    this.secretIssue = secretProblem(secret);
    this.error = this.load();
  }

  private load(): string | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      return `${this.file} can't be read (${(err as Error).message})`;
    }
    if (!this.secret) return `${this.file} exists but RELAY_SECRET is not set (or too short), so stored credentials are not used.`;
    let sealed: unknown;
    try {
      sealed = JSON.parse(raw);
    } catch {
      return `${this.file} is damaged (not JSON). Restore it from a backup or move it aside, then restart the relay.`;
    }
    try {
      this.data = parseData(unseal(this.secret, sealed));
    } catch (err) {
      const why = err instanceof UnsealError && err.message === "can't be decrypted" ? "can't be decrypted: RELAY_SECRET changed or the file was modified" : "is damaged";
      return `${this.file} ${why}. Restore RELAY_SECRET or the file, or move it aside, then restart the relay.`;
    }
    return null;
  }

  /** Why writes are refused, or null. */
  writeProblem(): string | null {
    return this.secretIssue ?? this.error;
  }

  private persist(next: StoreData) {
    const problem = this.writeProblem();
    if (problem) throw new CredentialsError(503, "credentials unavailable", problem);
    const body = JSON.stringify(seal(this.secret!, JSON.stringify(next)));
    const dir = path.dirname(this.file);
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const fd = fs.openSync(tmp, "w", 0o600);
      try {
        fs.writeFileSync(fd, body);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.file);
      try {
        fs.chmodSync(this.file, 0o600);
      } catch {}
      syncDir(dir);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {}
      throw new CredentialsError(503, "credentials not saved", `could not write ${this.file} (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    }
    this.data = next;
  }

  private clone(): StoreData {
    return { keys: { ...this.data.keys }, custom: { ...this.data.custom } };
  }

  /** Stores (or with null / "" clears) a slot's value. */
  setKey(env: string, raw: unknown, now = Date.now()): void {
    const slot = slotFor(env);
    if (!slot) throw new CredentialsError(404, "unknown key", `${env} is not a catalog key variable`);
    const next = this.clone();
    if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
      if (!Object.hasOwn(next.keys, env)) return;
      delete next.keys[env];
    } else {
      next.keys[env] = { value: checkSlotValue(slot, raw), updatedAt: now };
    }
    this.persist(next);
  }

  addCustom(input: { label: unknown; value?: unknown; note?: unknown }, now = Date.now()): string {
    const label = checkLabel(input.label);
    const note = checkNote(input.note);
    const value = input.value === undefined || input.value === null || input.value === "" ? null : checkSecretValue(input.value);
    if (Object.keys(this.data.custom).length >= MAX_CUSTOM) throw new CredentialsError(400, "too many services", `at most ${MAX_CUSTOM} custom services`);
    let id = "";
    do id = `${slug(label)}-${randomBytes(3).toString("hex")}`;
    while (Object.hasOwn(this.data.custom, id));
    const next = this.clone();
    next.custom[id] = { label, value, note, createdAt: now, updatedAt: now };
    this.persist(next);
    return id;
  }

  /** Updates a custom service: fields left out are kept; value null or "" clears the secret. */
  updateCustom(id: string, input: { label?: unknown; value?: unknown; note?: unknown }, now = Date.now()): void {
    const current = ownEntry(this.data.custom, id);
    if (!current) throw new CredentialsError(404, "unknown service", `no custom service ${id}`);
    const next = this.clone();
    next.custom[id] = {
      ...current,
      label: input.label === undefined ? current.label : checkLabel(input.label),
      note: input.note === undefined ? current.note : checkNote(input.note),
      value: input.value === undefined ? current.value : input.value === null || input.value === "" ? null : checkSecretValue(input.value),
      updatedAt: now,
    };
    this.persist(next);
  }

  deleteCustom(id: string): StoredCustom {
    const current = ownEntry(this.data.custom, id);
    if (!current) throw new CredentialsError(404, "unknown service", `no custom service ${id}`);
    const next = this.clone();
    delete next.custom[id];
    this.persist(next);
    return current;
  }

  /** The environment the store wants: editable slots only, and nothing when the file couldn't be opened. */
  desiredEnv(): Record<string, string> {
    if (this.error) return {};
    const out: Record<string, string> = {};
    for (const slot of credentialSlots()) {
      const stored = ownEntry(this.data.keys, slot.env);
      if (stored) out[slot.env] = stored.value;
    }
    return out;
  }
}

/** fsync the directory so the rename survives a crash (best effort). */
function syncDir(dir: string) {
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
}

// --- Environment ---------------------------------------------------------------------

/**
 * Applies stored values to an environment object and undoes them. Remembers
 * each variable's value from before the store touched it; when something else
 * replaced an applied value (e.g. the dev server reloaded .env files), that
 * becomes the new original and the stored value is applied again.
 */
/** What an EnvBinding remembers; plain data so it can be shared through globalThis. */
export type BindingState = { originals: Map<string, string | undefined>; applied: Map<string, string> };

export class EnvBinding {
  private readonly originals: Map<string, string | undefined>;
  private readonly applied: Map<string, string>;

  constructor(state: BindingState = { originals: new Map(), applied: new Map() }) {
    this.originals = state.originals;
    this.applied = state.applied;
  }

  apply(env: Env, desired: Record<string, string>): void {
    for (const [name] of [...this.applied]) {
      if (name in desired) continue;
      const original = this.originals.get(name);
      if (env[name] === this.applied.get(name)) {
        if (original === undefined) delete env[name];
        else env[name] = original;
      }
      this.applied.delete(name);
      this.originals.delete(name);
    }
    for (const [name, value] of Object.entries(desired)) {
      if (!this.applied.has(name) || env[name] !== this.applied.get(name)) this.originals.set(name, env[name]);
      env[name] = value;
      this.applied.set(name, value);
    }
  }

  /** The variable's value as the environment had it, ignoring the store. */
  original(env: Env, name: string): string | undefined {
    if (this.applied.has(name) && env[name] === this.applied.get(name)) return this.originals.get(name);
    return env[name];
  }

  bound(): string[] {
    return [...this.applied.keys()];
  }
}

// --- Views -------------------------------------------------------------------------------

const present = (v: string | undefined) => !!v && v.trim() !== "";

/** Every slot as the API shows it. `privileged` (owner or admin) adds hints and non-secret values. */
export function keyViews(store: CredentialStore, binding: EnvBinding, env: Env, privileged: boolean): CredentialKeyView[] {
  return credentialSlots().map((slot) => keyView(slot, store, binding, env, privileged));
}

export function keyView(slot: CredentialSlot, store: CredentialStore, binding: EnvBinding, env: Env, privileged: boolean): CredentialKeyView {
  const stored = store.error ? undefined : ownEntry(store.data.keys, slot.env);
  const fromEnv = binding.original(env, slot.env);
  const value = stored?.value ?? (present(fromEnv) ? fromEnv!.trim() : null);
  const view: CredentialKeyView = {
    env: slot.env,
    label: slot.label,
    apis: slot.apis,
    secret: slot.secret,
    kind: slot.kind,
    placeholder: slot.placeholder,
    set: value !== null,
    source: stored ? "store" : value !== null ? "env" : null,
    updatedAt: stored?.updatedAt ?? null,
    hint: privileged && value !== null ? (slot.secret ? redact(value) : value) : null,
  };
  if (privileged && !slot.secret && value !== null) view.value = value;
  return view;
}

export function customView(id: string, c: StoredCustom, privileged: boolean): CustomServiceView {
  return {
    id,
    label: c.label,
    set: c.value !== null,
    updatedAt: c.updatedAt || null,
    hint: privileged && c.value !== null ? redact(c.value) : null,
    ...(privileged ? { note: c.note } : {}),
  };
}

export function customViews(store: CredentialStore, privileged: boolean): CustomServiceView[] {
  if (store.error) return [];
  return Object.entries(store.data.custom)
    .sort(([, a], [, b]) => a.createdAt - b.createdAt)
    .map(([id, c]) => customView(id, c, privileged));
}

// --- Process runtime -------------------------------------------------------------------------

export type CredentialsRuntime = { store: CredentialStore; binding: EnvBinding };

// On globalThis, and without instanceof checks: instrumentation.ts and the route
// handlers may be separate bundles (each with its own copy of these classes), and
// all of them must share ONE store and ONE record of the original values, or a
// stale copy would re-apply old values or "restore" a stored key.
const g = globalThis as unknown as {
  __relayCredentials?: { key: string; store: CredentialStore };
  __relayEnvBindingState?: BindingState;
  __relayCredentialsTimer?: ReturnType<typeof setInterval>;
};

export const credentialsFile = (dataDir: string) => path.resolve(dataDir, CREDENTIALS_FILE);

/**
 * The store for the current RELAY_DATA_DIR and RELAY_SECRET (reloaded when
 * either changes), with its values applied to `env`.
 */
export function credentialsRuntime(env: Env = process.env): CredentialsRuntime {
  const file = credentialsFile(loadConfig(env).dataDir);
  const secret = env.RELAY_SECRET;
  const key = `${file}|${secretFingerprint(usableSecret(secret))}`;
  if (g.__relayCredentials?.key !== key) g.__relayCredentials = { key, store: new CredentialStore(file, secret) };
  g.__relayEnvBindingState ??= { originals: new Map(), applied: new Map() };
  const runtime = { store: g.__relayCredentials.store, binding: new EnvBinding(g.__relayEnvBindingState) };
  runtime.binding.apply(env, runtime.store.desiredEnv());
  return runtime;
}

/** Re-applies the store to process.env (after a write, or when something reset the environment). */
export const applyCredentials = (runtime: CredentialsRuntime, env: Env = process.env) => runtime.binding.apply(env, runtime.store.desiredEnv());

/**
 * Called once at server start (instrumentation.ts): loads the store, applies it
 * to process.env and re-applies it every few seconds if something (a dev-server
 * .env reload) put the environment back. Logs a one-line summary, never a value.
 */
export function initCredentials(env: Env = process.env): CredentialsRuntime {
  const runtime = credentialsRuntime(env);
  const count = Object.keys(runtime.store.desiredEnv()).length;
  if (runtime.store.error) console.warn(`[relay] stored credentials not used: ${runtime.store.error}`);
  else if (count) console.info(`[relay] using ${count} stored credential${count === 1 ? "" : "s"} from ${runtime.store.file}`);
  if (g.__relayCredentialsTimer) clearInterval(g.__relayCredentialsTimer);
  g.__relayCredentialsTimer = setInterval(() => {
    try {
      credentialsRuntime(env);
    } catch {}
  }, 2_000);
  g.__relayCredentialsTimer.unref?.();
  return runtime;
}

/** Names of upstream overrides that may be stored (for docs and tests). */
export const UPSTREAM_ENVS = UPSTREAM_SLOTS.map((u) => u.env);
