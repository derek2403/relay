"use client";

import { useCallback, useState } from "react";
import type { Hex, TransactionReceipt } from "viem";
import { usePublicClient } from "wagmi";

import { type DecodedLog, decodeEnsLogs, formatError } from "@/lib/ens/errors";
import { CHAIN_ID } from "@/lib/wagmi";

export type TxResult = {
  hash: Hex;
  receipt: TransactionReceipt;
  events: DecodedLog[];
};

export type TxState =
  | { status: "idle" }
  | { status: "signing" }
  | { status: "pending"; hash: Hex }
  | ({ status: "success" | "reverted" } & TxResult)
  | { status: "error"; error: string; hash?: Hex };

/**
 * Runs a write, waits for the receipt and decodes ENSv2 events from it.
 *
 *   const { mutateAsync } = useWriteContract();
 *   const tx = useTx();
 *   await tx.run(() => mutateAsync({ address, abi, functionName, args }));
 *
 * `run` resolves to the receipt and decoded events on success, or null on
 * rejection/revert, so multi-step flows can chain on the result.
 */
export function useTx() {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const [state, setState] = useState<TxState>({ status: "idle" });

  const run = useCallback(
    async (send: () => Promise<Hex>): Promise<TxResult | null> => {
      setState({ status: "signing" });
      let hash: Hex | undefined;
      try {
        hash = await send();
        setState({ status: "pending", hash });
        if (!client) throw new Error("No public client for Sepolia");
        const receipt = await client.waitForTransactionReceipt({ hash });
        const result = { hash, receipt, events: decodeEnsLogs(receipt.logs) };
        setState({ status: receipt.status === "success" ? "success" : "reverted", ...result });
        return receipt.status === "success" ? result : null;
      } catch (e) {
        setState({ status: "error", error: formatError(e), hash });
        return null;
      }
    },
    [client],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);
  const busy = state.status === "signing" || state.status === "pending";

  return { state, run, reset, busy };
}

export type Tx = ReturnType<typeof useTx>;
