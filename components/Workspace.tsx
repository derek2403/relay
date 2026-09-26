"use client";

import { LiveWorkspace } from "./live/LiveWorkspace";

/** Client root of the workspace UI: the company's ENS tree on Sepolia and this relay. */
export function Workspace() {
  return <LiveWorkspace />;
}
