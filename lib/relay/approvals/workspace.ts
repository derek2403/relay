// The workspace's named payment recipients (org/chain.json, or the file named
// by RELAY_CHAIN_CONFIG), for rule R7. Read through the chain workspace loader
// (lib/chain/config.ts, strict and cached by file change); a missing or
// invalid file means "no known recipients" (every new recipient trips R7:
// fail closed).

import type { Address } from "viem";

import { loadChainWorkspace } from "../../chain/config";

export function knownRecipients(env: Record<string, string | undefined> = process.env): Record<string, Address> {
  let ws;
  try {
    ws = loadChainWorkspace(env);
  } catch {
    ws = null;
  }
  const value: Record<string, Address> = {};
  for (const [name, addr] of Object.entries(ws?.recipients ?? {})) value[name.toLowerCase()] = addr;
  return value;
}
