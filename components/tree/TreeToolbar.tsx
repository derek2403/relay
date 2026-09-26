import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { ALL_BRANCHES } from "@/lib/view-model";

type TreeToolbarProps = {
  rootName: string;
  branches: readonly { id: string; label: string }[];
  branch: string;
  onBranchChange: (branch: string) => void;
  query: string;
  onQueryChange: (query: string) => void;
  actions?: ReactNode;
};

const FIELD_TAGS = ["INPUT", "SELECT", "TEXTAREA"];

export function TreeToolbar({ rootName, branches, branch, onBranchChange, query, onQueryChange, actions }: TreeToolbarProps) {
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" jumps to the search field unless a field has focus or a dialog is open.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const typing = FIELD_TAGS.includes(document.activeElement?.tagName ?? "");
      if (event.key !== "/" || typing || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="tree-toolbar">
      <div className="tree-title">
        <span className="tree-symbol">
          <Icon name="tree" />
        </span>
        <strong>The family tree</strong>
        <span className="subtle">{`/ ${rootName}`}</span>
      </div>
      <div className="tree-actions">
        <select id="branchSelect" aria-label="Show department" value={branch} onChange={(event) => onBranchChange(event.target.value)}>
          <option value={ALL_BRANCHES}>All departments</option>
          {branches.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <label className="search">
          <span>
            <Icon name="search" />
          </span>
          <input
            id="search"
            ref={searchRef}
            placeholder="Find an identity…"
            aria-label="Find an identity"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          <kbd>/</kbd>
        </label>
        {actions}
      </div>
    </div>
  );
}
