"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useEnsName } from "wagmi";
import { ActivityList } from "@/components/activity/ActivityList";
import { DetailPanel } from "@/components/details/DetailPanel";
import { Metrics } from "@/components/shell/Metrics";
import { PageHeading } from "@/components/shell/PageHeading";
import { SectionHeading } from "@/components/shell/SectionHeading";
import { Sidebar, type NavItem, type Profile } from "@/components/shell/Sidebar";
import { TreeView } from "@/components/tree/TreeView";
import { UnderTree } from "@/components/tree/UnderTree";
import { Icon } from "@/components/ui/Icon";
import { Toast, useToast } from "@/components/ui/Toast";
import { cx } from "@/lib/cx";
import { tryNormalize } from "@/lib/ens/names";
import { useLocalJson } from "@/lib/hooks/useLocalJson";
import { useRelayAgentKeys } from "@/lib/hooks/useRelayAgents";
import { childrenQuery, useRelayPolicy, useRelayRefresh, useRelayStatus } from "@/lib/hooks/useRelayApi";
import { useClock, useLiveLog, useOwnedNames } from "@/lib/live/hooks";
import { useLiveTree } from "@/lib/live/useLiveTree";
import {
  type TimedActivity,
  depthBelow,
  initialsFor,
  levelSpend,
  lineageOf,
  liveChainGrant,
  liveGrants,
  liveMetrics,
  liveProviders,
  mergeActivity,
  roleFor,
  toLiveNodes,
} from "@/lib/live/view";
import { DRAFT_ROOT_STORAGE, errorText, needsSignIn } from "@/lib/relay/browser";
import type { ProviderId } from "@/lib/relay/catalog";
import type { ChildrenResponse } from "@/lib/relay/types";
import { ALL_BRANCHES, indexProviders, shortAddress, visibleNodes } from "@/lib/view-model";
import { CHAIN_ID } from "@/lib/wagmi";
import { AdminSignIn, LiveNotice, NoRootNotice, RelayClosed, RelayUnreachable, isRootName } from "./actions/LiveNotices";
import { NodeActions } from "./actions/NodeActions";
import { AgentsView } from "./agents/AgentsView";
import { ApprovalsView } from "./approvals/ApprovalsView";
import { useChainStatus, useRootChainRecord } from "./chain/hooks";
import { firstTeam } from "./agents/model";
import { LiveSpend } from "./agents/LiveSpend";
import { LiveContext, type LiveContextValue, type LiveViewId, type ReviewTarget } from "./LiveContext";
import { PoliciesView } from "./policies/PoliciesView";
import { ProvidersLiveView } from "./providers/ProvidersLiveView";
import { SetupView } from "./setup/SetupView";
import { WalletButton } from "./wallet/WalletButton";

const TITLES: Record<LiveViewId, string> = {
  tree: "Access tree",
  providers: "Providers",
  agents: "Agents",
  approvals: "Approvals",
  policies: "Policies",
  setup: "Setup",
};

const DESCRIPTIONS: Record<LiveViewId, string> = {
  tree: "Who may use which API, and how much, from the company down to each subagent.",
  providers: "Keys stay in the relay. Names only carry limits.",
  agents: "Agent keys in this browser, and what the relay decided.",
  approvals: "Incidents and blockchain proposals waiting for a human.",
  policies: "Shared limits, and who may change them.",
  setup: "What the relay serves, and what is left to set up.",
};

const VIEWS = Object.keys(TITLES) as LiveViewId[];

/** The detail panel's and the header's spend: re-read while the page is open, as agents spend. */
const SPEND_POLL_MS = 5_000;
/**
 * Listings of teams and everything below them, re-read so names the CLI creates show up
 * without a Refresh. The live view keeps its user's listings fresher (every 6 s); listings
 * updated recently are skipped, which keeps this well inside the relay's children budget.
 */
const TREE_POLL_MS = 30_000;

/** Same value object while its JSON is unchanged, so polling doesn't redraw the tree or close its popover. */
function useStable<T>(value: T): T {
  const key = JSON.stringify(value);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => value, [key]);
}

/**
 * Clicks a feature's own button (by its data-live-action) so the heading action opens the
 * same flow as the panel. Returns false when the selected name offers no such action.
 */
function runPanelAction(action: string): boolean {
  const button = document.querySelector<HTMLButtonElement>(`[data-live-action="${action}"]:not([disabled])`);
  if (!button) return false;
  button.scrollIntoView({ block: "center", behavior: "smooth" });
  button.click();
  return true;
}

/** The workspace: the company's ENS tree on Sepolia and this relay, in the khaki shell. */
export function LiveWorkspace() {
  const queryClient = useQueryClient();
  const relayRefresh = useRelayRefresh();
  const status = useRelayStatus();
  const [draftRoot, saveDraftRoot] = useLocalJson<string>(DRAFT_ROOT_STORAGE, "");
  const draft = tryNormalize(draftRoot);
  // RELAY_ROOT_NAME wins; until it's set, live mode works on the name typed in this browser.
  const root = status.data?.root ?? (isRootName(draft) ? draft : null);

  const { address, chainId } = useConnection();
  const onSepolia = chainId === CHAIN_ID;
  const { data: ensName } = useEnsName({ address, chainId: CHAIN_ID });
  const agentKeys = useRelayAgentKeys();
  const now = useClock();
  const tree = useLiveTree(root);

  const [view, setViewState] = useState<LiveViewId>("tree");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [branch, setBranch] = useState(ALL_BRANCHES);
  const [query, setQuery] = useState("");
  const [fitRequest, setFitRequest] = useState(0);
  const [events, setEvents] = useState<TimedActivity[]>([]);
  /** Bumped by the page heading's "Add a provider"; ProvidersLiveView opens its dialog on each change. */
  const [addProviderRequest, setAddProviderRequest] = useState(0);
  const [review, setReview] = useState<ReviewTarget | null>(null);
  const { toast: toastState, showToast } = useToast();

  // relay.chain records: the root's from its resolver, every other name's from its parent's listing.
  const rootChain = useRootChainRecord(root, tree.rootNode.resolver ?? null);
  const raw = tree.raw.map((node) => {
    if (node.name === root) return { ...node, chain: rootChain };
    const parentName = node.name.slice(node.name.indexOf(".") + 1);
    const listing = queryClient.getQueryData<ChildrenResponse>(childrenQuery(parentName).queryKey);
    return { ...node, chain: listing?.children.find((child) => child.name === node.name)?.chain };
  });
  const nodes = useStable(
    root ? toLiveNodes({ root, raw, nowSec: now, address, hasAgentKey: (owner) => !!agentKeys.find(owner) }) : [],
  );
  const chainStatus = useChainStatus(!!status.data);
  const providers = useMemo(() => liveProviders(status.data), [status.data]);
  const providerIndex = useMemo(() => indexProviders(providers), [providers]);
  const rootView = nodes.find((node) => node.parentId === null) ?? null;
  const selected = nodes.find((node) => node.id === selectedId) ?? rootView;
  const parent = selected?.parentId ? nodes.find((node) => node.id === selected.parentId) : undefined;

  // Production without RELAY_ADMIN_TOKEN: spend and the log are only for agent tokens, so don't ask.
  const viewClosed = status.data?.viewAuth === "closed";
  const policy = useRelayPolicy(viewClosed ? null : (selected?.name ?? null), undefined, view === "tree" && SPEND_POLL_MS);
  const rootPolicy = useRelayPolicy(viewClosed ? null : root, undefined, SPEND_POLL_MS);
  const log = useLiveLog(20, 5_000, !!status.data && !viewClosed);
  const owned = useOwnedNames(address, !!status.data?.root);

  // Stable callbacks for the context: features may use them in effects.
  const toastRef = useRef(showToast);
  useEffect(() => {
    toastRef.current = showToast;
  });
  const toast = useCallback((message: string) => toastRef.current(message), []);
  const log_ = useCallback((title: string, detail: string) => {
    const at = Date.now();
    setEvents((current) => [{ id: `local-${at}-${current.length}`, at, title, detail, time: new Date(at).toLocaleTimeString() }, ...current].slice(0, 50));
  }, []);
  const refresh = useCallback(async () => {
    await Promise.all([
      relayRefresh(),
      // Relay answers a write (or the toolbar's Refresh) can change too.
      ...["relay-status", "relay-owned", "relay-log", "relay-admin-probe", "relay-credentials"].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    ]);
  }, [relayRefresh, queryClient]);
  // Re-read the tree's lower listings while the tree is on screen (and the tab visible).
  const listedRef = useRef<readonly string[]>([]);
  useEffect(() => {
    listedRef.current = tree.listed;
  });
  useEffect(() => {
    if (view !== "tree" || !root) return;
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      for (const name of listedRef.current) {
        if (depthBelow(root, name) < 2) continue;
        const { queryKey } = childrenQuery(name);
        const state = queryClient.getQueryState(queryKey);
        if (state?.fetchStatus === "fetching" || (state && now - state.dataUpdatedAt < TREE_POLL_MS / 2)) continue;
        void queryClient.invalidateQueries({ queryKey, exact: true });
      }
    }, TREE_POLL_MS);
    return () => clearInterval(id);
  }, [view, root, queryClient]);

  const setView = useCallback((next: LiveViewId) => {
    setViewState(next);
    if (next === "tree") setFitRequest((count) => count + 1);
  }, []);
  const select = useCallback((id: string) => setSelectedId(id), []);
  const openReview = useCallback(
    (target: ReviewTarget) => {
      setReview(target);
      setView("approvals");
    },
    [setView],
  );
  const clearReview = useCallback(() => setReview(null), []);
  // Deep links the relay hands out: /?view=approvals&incident=inc_… (or &proposal=prp_…).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const incident = params.get("incident");
    const proposal = params.get("proposal");
    const id = incident ?? proposal;
    if (id && /^(inc|prp)_[A-Za-z0-9_-]{1,64}$/.test(id)) openReview({ kind: incident ? "incident" : "proposal", id });
    else if (params.get("view") === "approvals") setView("approvals");
  }, [openReview, setView]);
  const setDraftRoot = useCallback((name: string) => saveDraftRoot(name), [saveDraftRoot]);

  const context = useMemo<LiveContextValue>(
    () => ({
      root,
      setDraftRoot,
      status: status.data,
      statusError: status.error,
      nodes,
      providerIndex,
      treeLoading: tree.loading,
      selected,
      select,
      address,
      onSepolia,
      view,
      setView,
      refresh,
      log: log_,
      toast,
      openReview,
      review,
      clearReview,
    }),
    [root, setDraftRoot, status.data, status.error, nodes, providerIndex, tree.loading, selected, select, address, onSepolia, view, setView, refresh, log_, toast, openReview, review, clearReview],
  );

  const configured = (id: ProviderId) => (status.data ? (providerIndex[id]?.configured ?? false) : undefined);
  const chainDetail = selected ? liveChainGrant(nodes, selected.id, chainStatus.data?.recipients ?? {}, now || undefined) : null;
  const grants = selected ? liveGrants({ lineage: lineageOf(nodes, selected.id), policyLevels: policy.data?.levels ?? null, configured }) : [];
  const metrics = liveMetrics({
    nodes,
    providers,
    providerIndex,
    root,
    rootSpend: levelSpend(rootPolicy.data?.levels[0]),
    rootPeriod: rootView?.bundle?.period ?? null,
    spendClosed: viewClosed,
  });
  const activity = mergeActivity(log.data, events);
  const profile: Profile = {
    initials: initialsFor(ensName, address),
    name: ensName ?? (address ? shortAddress(address) : "No wallet"),
    role: roleFor(address, nodes, owned.data?.names),
  };

  const navItems: NavItem<LiveViewId>[] = VIEWS.map((id) =>
    id === "tree" ? { view: id, label: TITLES[id], count: visibleNodes(nodes, branch).length, countId: "navCount" } : { view: id, label: TITLES[id] },
  );
  const headingAction =
    view === "tree"
      ? {
          label: "Add a member",
          onClick: () => {
            // On the company itself this would add a department: people go under a team.
            if (!selected || selected.parentId === null) {
              toast(`Select the team to add them to in the tree${firstTeam(nodes) ? ` (e.g. ${firstTeam(nodes)})` : ""}, then click Add a member.`);
              return;
            }
            if (!runPanelAction("add-member")) toast("Select a name you manage in the tree, then add a member from its panel.");
          },
        }
      : view === "providers"
        ? { label: "Add a provider", onClick: () => setAddProviderRequest((count) => count + 1) }
        : undefined;

  const rootMissing = !!root && !tree.loading && !tree.error && !!tree.rootNode.state && !tree.rootNode.active;
  const treeNotice = status.isLoading ? (
    <LiveNotice title="Checking the relay…" />
  ) : !root ? (
    status.error ? (
      <RelayUnreachable error={status.error} draftRoot={draftRoot} onDraftRoot={setDraftRoot} />
    ) : (
      <NoRootNotice draftRoot={draftRoot} onDraftRoot={setDraftRoot} onOpenSetup={() => setView("setup")} />
    )
  ) : tree.error ? (
    <LiveNotice title={`Couldn't read ${root} from Sepolia`} tone="warning">
      <p>{errorText(tree.error as Error)}</p>
    </LiveNotice>
  ) : rootMissing ? (
    <LiveNotice title={`${root} isn't registered`}>
      <p>Register it, give it limits and enable names below it in Setup.</p>
      <button type="button" className="parent-link" onClick={() => setView("setup")}>
        Open setup
      </button>
    </LiveNotice>
  ) : !rootView && tree.loading ? (
    <LiveNotice title={`Loading ${root} from Sepolia…`} />
  ) : null;

  const details = (
    <DetailPanel
      node={selected}
      grants={grants}
      parentLabel={parent?.label ?? null}
      providerIndex={providerIndex}
      chain={chainDetail}
      note={
        selected?.aliasOf
          ? `Alias of ${selected.aliasOf}: the same group, reached through a second path. The relay refuses names under this path, so manage it at ${selected.aliasOf}.`
          : viewClosed
            ? "Every level above must allow the API. Spend is hidden: the relay has no RELAY_ADMIN_TOKEN."
            : policy.error && needsSignIn(policy.error)
              ? "Every level above must allow the API. Sign in as admin to see spend."
              : "Every level above must allow the API. Removal and expiry cascade. Spend comes from the relay."
      }
      onSelectParent={() => {
        if (parent) setSelectedId(parent.id);
      }}
      actions={selected && <NodeActions key={selected.id} node={selected} />}
    />
  );

  return (
    <LiveContext value={context}>
      <div className="live-workspace">
        <div className="app">
          <Sidebar items={navItems} activeView={view} onSelectView={setView} accountControls={<WalletButton />} profile={profile} />
          <div className="main">
            <main>
              <PageHeading title={TITLES[view]} description={DESCRIPTIONS[view]} action={headingAction} />
              <Metrics metrics={metrics} onManageProviders={() => setView("providers")} />
              <section id="treeView" className={cx("view", view !== "tree" && "hidden")}>
                {status.error && root && <RelayUnreachable error={status.error} draftRoot={draftRoot} onDraftRoot={setDraftRoot} />}
                {treeNotice}
                {tree.listError && (
                  <LiveNotice title={`Couldn't load names under ${tree.listErrorName}`} tone="warning">
                    <p>{errorText(tree.listError)}</p>
                  </LiveNotice>
                )}
                {tree.truncated && <p className="form-hint">Showing the first names only. The tree is larger than this view loads.</p>}
                {rootView && rootView.status !== "Revoked" && (
                  <TreeView
                    nodes={nodes}
                    providerIndex={providerIndex}
                    rootName={root ?? ""}
                    selectedId={selected?.id ?? ""}
                    onSelect={setSelectedId}
                    branch={branch}
                    onBranchChange={setBranch}
                    query={query}
                    onQueryChange={setQuery}
                    fitRequest={fitRequest}
                    toolbarActions={
                      <button
                        className="icon-button"
                        title="Refresh"
                        aria-label="Refresh from Sepolia and the relay"
                        onClick={() => void refresh().then(() => toast("Refreshed from Sepolia and the relay."))}
                      >
                        <Icon name="reset" />
                      </button>
                    }
                    details={details}
                  />
                )}
                <UnderTree note={`Sepolia ENSv2${status.data ? ` · relay at ${status.data.baseUrl}` : ""}`} />
                {view === "tree" && rootView && rootView.status !== "Revoked" && (
                  <section className="inline-activity agents-view" aria-label="Live view">
                    <SectionHeading
                      title="Live view"
                      subtitle="The selected user (or the newest), their agents and subagents: spend against every limit, every 3 s"
                    />
                    <LiveSpend />
                  </section>
                )}
                <section id="activityView" className="inline-activity">
                  <SectionHeading title="Workspace activity" subtitle="Relay decisions, every 5 s" />
                  {viewClosed && <RelayClosed />}
                  {needsSignIn(log.error) && <AdminSignIn what="its decision log" />}
                  {log.error && !needsSignIn(log.error) && (
                    <p className="form-hint">{`Couldn't read the relay log: ${errorText(log.error)}`}</p>
                  )}
                  {activity.length ? <ActivityList events={activity} /> : <p className="form-hint">No relay calls yet.</p>}
                </section>
              </section>
              {view === "providers" && (
                <section id="providersView" className="view">
                  <ProvidersLiveView addRequest={addProviderRequest} />
                </section>
              )}
              {view === "agents" && (
                <section id="agentsView" className="view">
                  <AgentsView />
                </section>
              )}
              {view === "approvals" && (
                <section id="approvalsView" className="view">
                  <ApprovalsView />
                </section>
              )}
              {view === "policies" && (
                <section id="policiesView" className="view">
                  <PoliciesView />
                </section>
              )}
              {view === "setup" && (
                <section id="setupView" className="view">
                  <SetupView />
                </section>
              )}
            </main>
          </div>
        </div>
        <Toast {...toastState} />
      </div>
    </LiveContext>
  );
}
