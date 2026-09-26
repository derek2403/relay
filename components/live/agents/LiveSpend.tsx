"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Address, zeroAddress } from "viem";
import { useReadContract, useWriteContract } from "wagmi";

import { useLive } from "@/components/live/LiveContext";
import { Icon } from "@/components/ui/Icon";
import { cx } from "@/lib/cx";
import { UserRegistryImplAbi } from "@/lib/ens/abis/UserRegistryImpl";
import { labelId, splitFirst } from "@/lib/ens/names";
import { RegistryRoles } from "@/lib/ens/roles";
import { childrenQuery } from "@/lib/hooks/useRelayApi";
import { useLiveLog } from "@/lib/live/hooks";
import { LIVE_POLL_MS, type LiveData, subtreeNames, useRelayLive, wasSeenLive } from "@/lib/hooks/useRelayLive";
import { useTx } from "@/lib/hooks/useTx";
import {
  type LiveState,
  depthOf,
  errorText,
  formatDate,
  formatDuration,
  isNever,
  liveCandidates,
  liveState,
  needsSignIn,
  parentOf,
  roleOf,
  usd,
  userOf,
} from "@/lib/relay/browser";
import type { LevelView, LogEntry } from "@/lib/relay/types";
import { CHAIN_ID } from "@/lib/wagmi";

import { TxButton } from "../tx/TxButton";
import { TxStatus } from "../tx/TxStatus";
import { AdminSignIn } from "./RelayLog";
import { ProviderUsage } from "./Usage";
import { STATE_TEXT, aboveLevels, decisionsFor, limitedOrUsed, logOutcome, providerKeys, teamFor, watchedUser } from "./model";

const stateOf = (data: LiveData, name: string, now: number): LiveState =>
  liveState(data.levels[name], name in data.liveExpiry ? data.liveExpiry[name] : undefined, now);

/**
 * The team's listing carries each user's entry (status, subregistry): re-read it so a user the
 * CLI just set up (agents enabled) or removed shows here and in the tree without a Refresh.
 */
const TEAM_POLL_MS = 10_000;

/**
 * One user, its agents and their subagents: spend against caps and counts against limits for
 * every API, updated every 3 seconds (SRC LiveView). Follows the user of the name selected in the tree.
 */
export function LiveSpend() {
  const { root, selected, status, statusError, address, select, nodes } = useLive();
  const queryClient = useQueryClient();
  const [pick, setPick] = useState<{ user: string; selectedAt: string | null } | null>(null);

  const selectedName = selected?.name ?? null;
  const watched = watchedUser(root, selectedName ? userOf(selectedName) : null, pick, selectedName);
  const team = teamFor(root, watched);
  const teamList = useQuery({ ...childrenQuery(team), refetchInterval: TEAM_POLL_MS, refetchIntervalInBackground: false });
  const statusLoading = !status && !statusError;
  // Without a pick, the newest user, skipping ones the admin holds itself (like the launch squad).
  const users = statusLoading
    ? []
    : liveCandidates(teamList.data?.children ?? [], {
        admins: [address, status?.rootOwner],
        seenLive: (name) => wasSeenLive(queryClient, name),
      });
  const user = watched ?? users[0] ?? null;

  const liveQuery = useRelayLive(user);
  const log = useLiveLog(50, LIVE_POLL_MS, !!status && status.viewAuth !== "closed");
  const data = liveQuery.data?.user === user ? liveQuery.data : undefined;

  if (!root) return <p className="form-hint">Set a company name first.</p>;

  const signIn = status?.viewAuth === "closed" || needsSignIn(liveQuery.error) || needsSignIn(log.error);
  const options = [...new Set([...(user ? [user] : []), ...users])];
  const onWatch = (next: string) => {
    // Selecting the user in the tree keeps both views on the same person when it is loaded there.
    if (nodes.some((n) => n.name === next)) {
      select(next);
      setPick(null);
    } else setPick({ user: next, selectedAt: selectedName });
  };

  return (
    <div className="agents-live">
      {options.length > 1 && (
        <label className="agents-watch">
          <span>Watching</span>
          <select value={user ?? ""} onChange={(e) => onWatch(e.target.value)} className="mono" aria-label="User to watch">
            {options.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      )}
      {signIn && <AdminSignIn what="spend and its log" />}
      {!user ? (
        <p className="form-hint">
          {teamList.isLoading || statusLoading ? "Looking for users…" : `No users yet. Select a user in the tree, or add a member under ${team}.`}
        </p>
      ) : !data ? (
        liveQuery.error && !signIn ? (
          <p className="form-hint">
            Couldn&apos;t read {user}: {errorText(liveQuery.error)}
          </p>
        ) : (
          !signIn && <p className="form-hint">Loading {user}…</p>
        )
      ) : (
        <Subtree
          data={data}
          error={liveQuery.error}
          // Stays on the removed user, so the view shows what was cut off.
          onRemoved={() => {
            onWatch(data.user);
            void liveQuery.refetch();
          }}
          log={log.data}
          logError={signIn ? null : log.error}
        />
      )}
    </div>
  );
}

function Subtree({
  data,
  error,
  onRemoved,
  log,
  logError,
}: {
  data: LiveData;
  error: Error | null;
  onRemoved: () => void;
  log: LogEntry[] | undefined;
  logError: Error | null;
}) {
  const now = Math.floor(data.updatedAt / 1000);
  const names = subtreeNames(data.user, data.kids);
  const userLevel = data.levels[data.user];
  const userState = stateOf(data, data.user, now);
  const above = aboveLevels(data.user, data.levels);
  const userKeys = providerKeys(userLevel);
  const entries = decisionsFor(log, data.user, data.since);

  // Already gone when this page opened: nothing was revoked here.
  if (userState === "gone") return <p className="form-hint">{data.user} isn&apos;t registered.</p>;

  return (
    <>
      {userState === "revoked" && (
        <p className="form-hint agents-alert">
          <b>{data.user} was removed.</b> Every name below it is cut off: their next call is refused, and anything still streaming stops within seconds.
        </p>
      )}

      <ul className="agents-live-list">
        {names.map((name) => (
          <LiveRow key={name} name={name} level={data.levels[name] ?? null} state={stateOf(data, name, now)} now={now} depth={depthOf(name) - 3} />
        ))}
      </ul>

      {above.length > 0 && userKeys.length > 0 && (
        <div className="agents-above">
          <span className="detail-section-title">
            Above {data.user.split(".")[0]}
            <span>every call also counts here</span>
          </span>
          {above.map((level) => (
            <div key={level.name} className="agents-above-row">
              <span className="agents-above-name">
                <span className="mono">{level.name}</span> <small>{roleOf(level.name)}</small>
              </span>
              <div className="agents-usage-grid">
                {userKeys
                  .filter((p) => level.bundle?.keys.includes(p) && limitedOrUsed(level, p))
                  .map((p) => (
                    <ProviderUsage key={p} level={level} provider={p} />
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <p className="form-hint">Last update failed ({errorText(error)}); showing what was read before.</p>}
      {!error && data.partialError && <p className="form-hint">Some names couldn&apos;t be read this time ({data.partialError}).</p>}

      <Decisions entries={entries} error={logError} />

      {userState === "live" && userLevel?.registry && (
        <RemoveUser user={data.user} registry={userLevel.registry} below={names.length - 1} onRemoved={onRemoved} />
      )}
    </>
  );
}

/** unregister on the team's registry (SRC LiveView RemoveUser): the user and everything below stop at once. */
function RemoveUser({ user, registry, below, onRemoved }: { user: string; registry: Address; below: number; onRemoved: () => void }) {
  const live = useLive();
  const { mutateAsync } = useWriteContract();
  // The team registry's owner holds ROLE_UNREGISTER on its root, which covers every name in it.
  const canRemove = useReadContract({
    address: registry,
    abi: UserRegistryImplAbi,
    functionName: "hasRootRoles",
    args: [RegistryRoles.ROLE_UNREGISTER, (live.address ?? zeroAddress) as Address],
    chainId: CHAIN_ID,
    query: { enabled: !!live.address },
  });
  const tx = useTx();
  const [confirming, setConfirming] = useState(false);
  const [label] = splitFirst(user);

  const remove = async () => {
    const r = await tx.run(() => mutateAsync({ address: registry, abi: UserRegistryImplAbi, functionName: "unregister", args: [labelId(label)], chainId: CHAIN_ID }));
    setConfirming(false);
    if (!r) return;
    onRemoved();
    await live.refresh();
    live.toast(`Removed ${user}.`);
    live.log("Name removed", `${user} and everything under it`);
  };

  const blocked = !live.address
    ? "Connect the admin wallet to remove this user."
    : canRemove.data === false
      ? `This wallet can't remove names under ${parentOf(user)}.`
      : null;

  return (
    <div className="agents-remove">
      {!confirming ? (
        <button
          type="button"
          className="danger"
          onClick={() => setConfirming(true)}
          disabled={!!blocked || canRemove.data !== true || tx.busy}
          title={blocked ?? undefined}
        >
          Remove {user}
        </button>
      ) : (
        <div className="agents-remove-confirm" role="alertdialog" aria-label={`Remove ${user}?`}>
          <b>Remove {user}?</b>
          <p>
            It stops working right away{below > 0 ? `, and so ${below === 1 ? "does the name" : `do the ${below} names`} under it` : ""}. No keys to
            rotate.
          </p>
          <div className="agents-remove-buttons">
            <TxButton tx={tx} variant="danger-solid" onClick={remove}>
              Yes, remove it
            </TxButton>
            <button type="button" className="secondary" onClick={() => setConfirming(false)} disabled={tx.busy}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {blocked && <p className="form-hint">{blocked}</p>}
      <TxStatus tx={tx} showEvents={false} />
    </div>
  );
}

function LiveRow({ name, level, state, now, depth }: { name: string; level: LevelView | null; state: LiveState; now: number; depth: number }) {
  const role = roleOf(name);
  const keys = providerKeys(level);
  const dim = state !== "live";
  const expiry = level?.expiry ?? null;

  return (
    <li className={cx("agents-live-row", state === "revoked" && "revoked")} style={{ marginLeft: `${depth * 24}px` }}>
      <div className="agents-live-head">
        {depth > 0 && <span className="agents-branch">└</span>}
        <span className="agents-live-icon">
          <Icon name={role === "user" ? "member" : role} />
        </span>
        <span className={cx("agents-live-name", "mono", state === "revoked" && "struck")}>{name}</span>
        <span className="status-pill">{role}</span>
        <span className={cx("status-pill", state !== "live" && "revoked")}>{STATE_TEXT[state]}</span>
        {state === "live" && expiry && !isNever(expiry) && (
          <span className="agents-meta" title={formatDate(expiry)}>
            {role === "user" ? `until ${new Date(expiry * 1000).toLocaleDateString()}` : `ends in ${formatDuration(expiry - now)}`}
          </span>
        )}
        {level?.bundle?.period && <span className="agents-meta">limits {level.bundle.period === "total" ? "in total" : `per ${level.bundle.period}`}</span>}
      </div>
      {keys.length > 0 ? (
        <div className="agents-usage-grid">
          {keys.map((p) => (
            <ProviderUsage key={p} level={level!} provider={p} dim={dim} />
          ))}
        </div>
      ) : (
        level && <small className="agents-meta">No limits set: the relay refuses every call.</small>
      )}
    </li>
  );
}

function Decisions({ entries, error }: { entries: LogEntry[]; error: Error | null }) {
  return (
    <div className="detail-section agents-decisions">
      <div className="detail-section-title">
        Latest relay decisions
        <span>this user and below</span>
      </div>
      {error ? (
        <p className="form-hint">Couldn&apos;t load the log: {errorText(error)}</p>
      ) : entries.length === 0 ? (
        <p className="agents-meta">No calls yet from these names.</p>
      ) : (
        <ul className="agents-decision-list">
          {entries.map((e, i) => {
            const o = logOutcome(e);
            return (
              <li key={`${e.ts}-${i}`}>
                <time className="mono">{new Date(e.ts).toLocaleTimeString()}</time>
                <span className="mono agents-live-name">{e.name}</span>
                <span className="agents-meta">{e.provider}</span>
                <span className={cx("status-pill", o.tone === "refused" && "revoked")}>{o.text}</span>
                {e.reason && <span className={cx("agents-reason", o.loud && "loud")}>{e.reason}</span>}
                {e.costUsd !== null && e.costUsd > 0 && (
                  <span className="mono agents-meta">
                    {usd(e.costUsd)}
                    {e.estimated ? " (est.)" : ""}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
