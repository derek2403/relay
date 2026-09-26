import type { ReactNode } from "react";

type TopbarProps = {
  title: string;
  network: string;
  /** Badges shown before the network pill. */
  children?: ReactNode;
};

export function Topbar({ title, network, children }: TopbarProps) {
  return (
    <header className="topbar">
      <div className="breadcrumb">
        {"Workspace "}
        <span>/</span>
        <strong id="breadcrumbTitle">{title}</strong>
      </div>
      <div className="header-right">
        {children}
        <span className="network">
          <i></i>
          {network}
        </span>
      </div>
    </header>
  );
}
