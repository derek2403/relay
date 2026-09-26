import {
  type Hex,
  decodeErrorResult,
  decodeEventLog,
  type Log,
} from "viem";

import { ensErrorsAbi } from "./abis/errors";
import { ensEventsAbi } from "./abis/events";

export type DecodedError = { name: string; args?: readonly unknown[]; message: string };

/** Decodes raw revert data against every ENSv2 contract's custom errors. */
export function decodeEnsError(data: Hex): DecodedError | null {
  try {
    const { errorName, args } = decodeErrorResult({ abi: ensErrorsAbi, data });
    return { name: errorName, args, message: `${errorName}(${formatArgs(args)})` };
  } catch {
    return null;
  }
}

// Plain-English hints for the reverts people hit most often.
const HINTS: Record<string, string> = {
  ERC20InsufficientAllowance: "Approve the token spend first.",
  ERC20InsufficientBalance: "Not enough test tokens; mint some first.",
  EACUnauthorizedAccountRoles: "Your account doesn't hold the role this action needs.",
  EACCannotGrantRoles: "You can only grant roles you hold the admin role for (and names don't allow granting admin roles).",
  EACCannotRevokeRoles: "You can only revoke roles you hold the admin role for.",
  CommitmentTooNew: "Wait a little longer after committing.",
  CommitmentTooOld: "The commitment expired; start over.",
  NameNotAvailable: "That name is already registered.",
  // Names are ERC-1155 tokens, so the new owner must accept them (onERC1155Received).
  ERC1155InvalidReceiver: "The new owner is a contract or smart wallet that can't hold names; use a normal wallet address.",
  CannotSetPastExpiry: "The expiry is already in the past; pick a later time.",
};

type ErrorLike = { name?: string; shortMessage?: string; message?: string; cause?: unknown; data?: unknown; raw?: unknown; reason?: string };

// Like viem's BaseError.walk, but duck-typed so it survives duplicate module copies.
function walk(error: unknown, match: (e: ErrorLike) => boolean): ErrorLike | null {
  let current = error as ErrorLike | undefined;
  while (current && typeof current === "object") {
    if (match(current)) return current;
    current = current.cause as ErrorLike | undefined;
  }
  return null;
}

const withHint = (name: string, message: string) => `Reverted: ${message}${HINTS[name] ? ` — ${HINTS[name]}` : ""}`;

/** Human-readable description of any viem/wagmi error, decoding ENS custom errors. */
export function formatError(error: unknown): string {
  if (!error) return "";
  if (walk(error, (e) => e.name === "UserRejectedRequestError")) return "Request rejected in wallet.";

  const revert = walk(error, (e) => e.name === "ContractFunctionRevertedError");
  if (revert) {
    const data = revert.data as { errorName?: string; args?: readonly unknown[] } | undefined;
    if (data?.errorName) return withHint(data.errorName, `${data.errorName}(${formatArgs(data.args)})`);
    if (typeof revert.raw === "string") {
      const decoded = decodeEnsError(revert.raw as Hex);
      if (decoded) return withHint(decoded.name, decoded.message);
    }
    if (revert.reason) return `Reverted: ${revert.reason}`;
  }

  // Some RPCs put the revert data on a nested cause without a ContractFunctionRevertedError.
  const withData = walk(error, (e) => typeof e.data === "string" && (e.data as string).startsWith("0x"));
  if (withData && (withData.data as string).length >= 10) {
    const decoded = decodeEnsError(withData.data as Hex);
    if (decoded) return withHint(decoded.name, decoded.message);
  }

  const e = error as ErrorLike;
  return e.shortMessage || e.message || String(error);
}

export type DecodedLog = {
  address: Hex;
  eventName: string;
  args: Record<string, unknown> | readonly unknown[] | undefined;
  logIndex: number | null;
};

/** Decodes receipt logs against every ENSv2 event; undecodable logs are skipped. */
export function decodeEnsLogs(logs: readonly Log[]): DecodedLog[] {
  const out: DecodedLog[] = [];
  for (const log of logs) {
    try {
      const { eventName, args } = decodeEventLog({ abi: ensEventsAbi, data: log.data, topics: log.topics });
      out.push({ address: log.address, eventName, args, logIndex: log.logIndex });
    } catch {
      // Unknown event or an ABI variant with different indexing; ignore.
    }
  }
  return out;
}

export function formatArgs(args: readonly unknown[] | undefined): string {
  return (args ?? []).map((a) => stringify(a)).join(", ");
}

/** JSON.stringify that renders bigints as decimal strings. */
export function stringify(value: unknown, space?: number): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), space) ?? String(value);
}
