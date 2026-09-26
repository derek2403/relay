import type { ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { cx } from "@/lib/cx";

/** `countId` is the id of the count badge (the tree's is `navCount`). */
export type NavItem<V extends string = string> = { view: V; label: string; count?: number; countId?: string };
export type Profile = { initials: string; name: string; role: string };

type SidebarProps<V extends string> = {
  items: NavItem<V>[];
  activeView: V;
  onSelectView: (view: V) => void;
  /** Wallet controls. */
  accountControls: ReactNode;
  profile: Profile;
};

export function Sidebar<V extends string = string>({ items, activeView, onSelectView, accountControls, profile }: SidebarProps<V>) {
  return (
    <aside className="sidebar">
      <a className="brand" href="./" aria-label="Relay home">
        <span className="brandmark">
          <Icon name="relay" />
        </span>
        RELAY
      </a>
      <div className="account-controls">{accountControls}</div>
      <div className="nav-label">WORKSPACE</div>
      <nav aria-label="Workspace">
        {items.map((item, index) => (
          <button
            key={item.view}
            className={cx("nav", item.view === activeView && "active")}
            data-view={item.view}
            onClick={() => onSelectView(item.view)}
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            {item.label}
            {item.count !== undefined && (
              <>
                {" "}
                <b id={item.countId}>{item.count}</b>
              </>
            )}
          </button>
        ))}
      </nav>
      <div className="side-bottom">
        <div className="protected">
          <span className="shield">
            <Icon name="shield" />
          </span>
          <strong>Keys stay in the relay</strong>
          <p>
            Access travels down.
            <br />
            Your API keys never do.
          </p>
        </div>
        <div className="profile">
          <span className="avatar">{profile.initials}</span>
          <div>
            <strong>{profile.name}</strong>
            <small>{profile.role}</small>
          </div>
        </div>
      </div>
    </aside>
  );
}
