// Clearing the meter for removed names (POST /api/relay/admin/reset, used by
// `npm run demo:reset`).
//
// Spend and counts are keyed by (namehash, EAC resource), so a removed and
// re-added name already starts from zero; this just drops the leftovers so
// the portal and the file don't carry them. Only names that are no longer
// registered are cleared (and, for names that are, the keys of their earlier
// registrations), unless the admin names them explicitly.

import { namehash, tryNormalize } from "../ens/names";
import { isChainReadError } from "./ens";
import type { PolicyDeps } from "./policy";

export type ResetResult = {
  /** Names whose spend, counts, reservations and (unless keepLog) log entries were cleared. */
  cleared: string[];
  /** Spend/count entries removed (including earlier registrations of names that are registered again). */
  keys: number;
  logEntries: number;
  /** Names left alone, and why. */
  skipped: { name: string; reason: string }[];
};

/**
 * `keepLog`: clear spend and counts only, and don't read names that are only in
 * the log (the open development mode: anyone who can reach the relay may call
 * it, so it must not delete the audit trail of removals).
 */
export async function resetMeter(deps: PolicyDeps, explicit?: string[], opts: { keepLog?: boolean } = {}): Promise<ResetResult> {
  const { meter, config, reader } = deps;
  const result: ResetResult = { cleared: [], keys: 0, logEntries: 0, skipped: [] };

  if (explicit) {
    for (const raw of explicit) {
      const name = tryNormalize(raw);
      if (!name) {
        result.skipped.push({ name: raw, reason: "not a valid ENS name" });
        continue;
      }
      result.keys += meter.clearNode(namehash(name));
      result.cleared.push(name);
    }
  } else {
    const root = config.rootName;
    // Every name with spend or counts, plus names that only appear in the log (e.g. refused calls).
    const candidates = new Map<string, string | null>();
    for (const { node, name } of meter.meteredNames()) candidates.set(node, name);
    for (const name of opts.keepLog ? [] : meter.loggedNames()) {
      const node = namehash(name).toLowerCase();
      if (!candidates.get(node)) candidates.set(node, name);
    }
    for (const [node, name] of candidates) {
      if (!name) {
        result.skipped.push({ name: node, reason: "the relay doesn't know this name" });
        continue;
      }
      if (!root || (name !== root && !name.endsWith(`.${root}`))) {
        result.skipped.push({ name, reason: root ? `not under ${root}` : "the relay has no root name" });
        continue;
      }
      let leaf;
      try {
        const levels = await reader.readLevels(root, name);
        leaf = levels[levels.length - 1];
      } catch (err) {
        result.skipped.push({ name, reason: isChainReadError(err) ? err.message : "could not read ENS" });
        continue;
      }
      if (leaf.status !== "registered") {
        result.keys += meter.clearNode(node);
        result.cleared.push(name);
      } else {
        // Still registered: keep the current registration, drop earlier ones.
        result.keys += meter.clearNode(node, (resource) => resource === (leaf.resource ?? "0"));
      }
    }
  }
  result.logEntries = opts.keepLog ? 0 : meter.trimLog(new Set(result.cleared));
  await meter.flush();
  return result;
}
