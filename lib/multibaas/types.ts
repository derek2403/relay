// MultiBaas REST shapes the relay uses (api/v0; see the OpenAPI spec). Only the
// fields the relay reads are typed; MultiBaas may send more.
//
// Number types differ by endpoint, as MultiBaas sends them: the chain status
// and events use JSON numbers, /transactions/{hash} and /blocks use decimal
// strings, receipts use hex strings.

import type { Address, Hex } from "viem";

/** Every MultiBaas answer: `{status, message, result}`; `message` is "success" on success. */
export type MbEnvelope<T> = { status: number; message: string; result?: T };

/** GET /chains/ethereum/status */
export type MbChainStatus = { chainID: number; networkID: number; blockNumber: number; version: string; baseFee?: string };

/** GET /plan (admin key): the deployment's limits and features. */
export type MbPlan = {
  name: string;
  updatedAt: string;
  limits: { name: string; limit: number | null; count?: number }[];
  features: { name: string; enabled: boolean }[];
};

/** An address-and-alias pair, as listed under a contract's instances. */
export type MbInstance = { alias: string; address: Address };

/** GET /contracts: one per label. */
export type MbContractOverview = { label: string; contractName: string; version: string; isFavorite?: boolean; deployable: boolean; instances: MbInstance[] };

/** GET /contracts/{label}/{version}. `rawAbi` is the ABI as a JSON string; `bin` is "0x" when not deployable. */
export type MbContract = {
  label: string;
  contractName: string;
  version: string;
  rawAbi: string;
  bin?: string;
  instances?: MbInstance[];
};

/** What `createContract` uploads. `rawAbi` may be given as the parsed ABI; it is sent as a JSON string. */
export type MbContractUpload = { contractName: string; version: string; rawAbi: string | readonly unknown[]; bin: Hex };

/** GET/POST /chains/ethereum/addresses/{address-or-alias}. `alias` is "" for an address without one. */
export type MbAddress = {
  alias: string;
  address: Address;
  chain: string;
  contracts: { label: string; name: string; version: string }[];
  /** Wei, decimal string (with include=balance). */
  balance?: string;
  nonce?: number;
};

/** GET …/addresses/{alias}/contracts/{label}/status */
export type MbIndexingStatus = {
  isProcessingPastLogs: boolean;
  latestBlockNumber: number;
  latestBlockHash: Hex;
  startBlockNumber: number;
  startBlockHash: Hex;
  updatedAt: string;
};

/**
 * An unsigned transaction MultiBaas composed. `value`, `gasPrice`, `gasFeeCap` and `gasTipCap`
 * are decimal wei strings; `gas` and `nonce` are numbers; `to` is null for a deploy.
 * `type` 2 is EIP-1559 (gasFeeCap/gasTipCap), 0 is legacy (gasPrice). `hash` is not the final hash.
 */
export type MbTx = {
  from: Address;
  to?: Address | null;
  nonce: number;
  gas: number;
  value: string;
  data: Hex | "";
  type: number;
  gasPrice?: string;
  gasFeeCap?: string;
  gasTipCap?: string;
  hash?: Hex;
};

/** POST …/methods/{method}: a read's decoded output, or a write's unsigned transaction. */
export type MbCallResult = { kind: "MethodCallResponse"; output: unknown } | { kind: "TransactionToSignResponse"; tx: MbTx; submitted?: boolean };

/** The body of a method call, deploy or transfer (PostMethodArgs; every field optional). */
export type MbMethodArgs = {
  args?: unknown[];
  from?: Address;
  to?: Address;
  /** Wei, decimal string. */
  value?: string;
  gas?: number;
  nonce?: number;
  signature?: string;
  contractOverride?: boolean;
  formatInts?: "auto" | "as_numbers" | "as_strings";
  preEIP1559?: boolean;
};

/** POST /contracts/{label}/{version}/deploy: the unsigned deploy transaction and where the contract will land. */
export type MbDeploy = { tx: MbTx; deployAt: Address; label?: string; submitted?: boolean };

/** POST /chains/ethereum/transactions/submit: the transaction as broadcast (JSON-RPC style hex fields). */
export type MbSubmitted = { tx: { hash: Hex; nonce?: Hex; from?: Address; to?: Address | null; [k: string]: unknown } };

/** GET /chains/ethereum/transactions/{hash}. `blockNumber` is a decimal string. */
export type MbTransaction = {
  data: { hash: Hex; nonce?: Hex; to?: Address | null; input?: Hex; value?: Hex; [k: string]: unknown };
  isPending: boolean;
  from: Address;
  blockHash?: Hex;
  blockNumber?: string;
};

/** GET /chains/ethereum/transactions/receipt/{hash}. `status` and `blockNumber` are hex. */
export type MbReceipt = {
  data: {
    status: Hex;
    blockNumber: Hex;
    blockHash: Hex;
    transactionHash: Hex;
    contractAddress?: Address | null;
    gasUsed?: Hex;
    effectiveGasPrice?: Hex;
    logs?: unknown[];
  };
  events?: MbEventInfo[];
};

/** GET /chains/ethereum/blocks/{n}. `number` is a decimal string. */
export type MbBlock = { hash: Hex; number: string; timestamp: number; parentHash: Hex; transactions?: unknown[] };

export type MbEventInput = { name: string; value: unknown; hashed?: boolean; type?: string };

export type MbEventInfo = {
  name: string;
  signature: string;
  inputs: MbEventInput[];
  /** The raw log as a JSON string (logIndex, removed, …). */
  rawFields?: string;
  contract: { address: Address; addressAlias?: string; addressLabel?: string; name: string; label: string };
  indexInLog: number;
};

/** GET /events: one decoded event with its transaction. */
export type MbEvent = {
  triggeredAt: string;
  event: MbEventInfo;
  transaction: { from: Address; txHash: Hex; txIndexInBlock: number; blockHash: Hex; blockNumber: number; txData?: Hex; contract?: unknown; method?: unknown };
};

/** GET /events filters (all optional; `limit` defaults to 10 on MultiBaas's side). */
export type MbEventFilter = {
  contract_address?: Address;
  contract_label?: string;
  event_signature?: string;
  tx_hash?: Hex;
  block_number?: number;
  block_hash?: Hex;
  limit?: number;
  offset?: number;
};

/** A receipt reduced to what the relay tracks. */
export type ReceiptSummary = {
  hash: Hex;
  blockNumber: number;
  blockHash: Hex;
  status: "success" | "reverted";
  contractAddress: Address | null;
};
