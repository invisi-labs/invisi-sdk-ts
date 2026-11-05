import type { NoteOutput } from "../NoteOutput";
import type { PublicWallet } from "@invisi-labs/core";
import type { GasBenchmarkProfile } from "../gas-estimation";
import type { Provider } from "ethers";
import type {
    Address,
    CancelCreditParams,
    CreateCreditParams,
    CreditDrawParams,
    Delivery,
    Hex,
    ShieldOutput,
    ShieldParams,
    TopUpCreditParams,
    TransactRequest,
} from "@invisi-labs/protocol/contracts";

import type { AuthorizedStatement, CreditDeliveryState, Note, Wallet } from "@invisi-labs/core";
import type {
    CanonicalBlock,
    ChainReader,
    CreditMembership,
    FundingInput,
    NoteMembership,
    Protocol,
    ProtocolDataProvider,
    TokenProtocol,
    TransactionContext,
    TransactRequestParams,
} from "@invisi-labs/protocol";
import type { AggregateMember, ProofBundle, Prover, ProverOptions } from "@invisi-labs/prover";

import type { CreditRecord, NoteRecord, WalletScope, Checkpoint } from "./records";
export interface CoinSelector {
    select(
        candidates: readonly NoteRecord[],
        requiredAmount: bigint
    ): readonly Hex[] | Promise<readonly Hex[]>;
}
export interface FundingTypedData {
    domain: Record<string, unknown>;
    primaryType: string;
    types: Record<string, readonly { name: string; type: string }[]>;
    message: Record<string, unknown>;
}
export interface FundingSigner {
    readonly address: Address;
    signTypedData(data: FundingTypedData): Promise<Hex>;
}
export interface FundingAuthorizationVerifier {
    verifyTypedData(
        data: FundingTypedData & { address: Address; signature: Hex }
    ): Promise<boolean>;
}
export interface FundingSource {
    payer: Address;
    amount: bigint;
    authorization?: "signature" | "caller";
    sigNonce?: bigint;
    deadline?: bigint;
    permit?: NonNullable<FundingInput["permit"]>;
}
/** Public submission mode; backend proof targets are selected internally. */
export type TransactionExecution = "single" | "aggregate";

export interface TransactionProveOptions extends ProverOptions {
    /** Defaults to single. Aggregate produces a member for a separate aggregate submission. */
    execution?: TransactionExecution;
}

export interface TransferPreparation {
    tokenAddress: Address;
    /** Explicit subset for managed inventory; detached calls already supply inputs. */
    commitments?: readonly Hex[];
    /** Public ERC20 payout. Empty private outputs are allowed when a payout is present. */
    withdrawal?: { to: Address; amount: bigint };
    /** Immediate public fee paid from this operation's token. */
    fee?: { recipient: Address; amount: bigint };
    outputs: readonly NoteOutput[];
    funding?: FundingSource;
    deadline?: bigint;
}
export interface ShieldPreparation {
    fee?: { recipient: Address; amount: bigint };
    tokenAddress: Address;
    outputs: readonly NoteOutput[];
    funding: FundingSource;
    deadline?: bigint;
}
export interface PreparedOutput {
    context: import("../NoteOutput").NoteOutputContext;
    recipient: import("../NoteOutput").NoteOutputRecipient;
    amount: bigint;
    note?: Note;
    commitment: Hex;
    identity: Hex;
    delivery: Delivery;
    /** Only offline encrypted EVM outputs may await registry-key resolution. */
    deliveryPending?: true;
    address: string;
    change: boolean;
}
export interface CreateCreditPreparation {
    fee?: { recipient: Address; amount: bigint };
    /** Version-specific application data. Omission uses built-in v1 with no data. */
    payload?: Uint8Array;
    singleLimit?: bigint;
    dailyLimit?: bigint;
    monthlyLimit?: bigint;
    tokenAddress: Address;
    spender: string;
    amount: bigint;
    expiry: bigint;
    funding?: FundingSource;
    deadline?: bigint;
}
export interface DrawCreditPreparation {
    tokenAddress: Address;
    credits: readonly {
        credit: Hex;
        amount: bigint;
        payload?: Uint8Array;
    }[];
    deadline?: bigint;
}
export interface TopUpCreditPreparation {
    fee?: { recipient: Address; amount: bigint };
    /** Version-specific application data. Omission uses built-in v1 with no data. */
    payload?: Uint8Array;
    /** Omission inherits the previous limit; zero disables it without clearing usage. */
    singleLimit?: bigint;
    dailyLimit?: bigint;
    monthlyLimit?: bigint;
    tokenAddress: Address;
    credit: Hex;
    additionalAmount: bigint;
    expiry?: bigint;
    funding?: FundingSource;
    deadline?: bigint;
}
export interface CancelCreditPreparation {
    fee?: { recipient: Address; amount: bigint };
    tokenAddress: Address;
    credit: Hex;
    deadline?: bigint;
}
export interface PreparedCreditOutput {
    state: CreditDeliveryState;
    commitment: Hex;
    deliveries: [Delivery, Delivery];
}
export interface PreparedCreditInput extends CreditMembership {
    commitment: Hex;
    role: "owner" | "spender";
}
export interface CreditPlan {
    inputs: PreparedCreditInput[];
    outputs: PreparedCreditOutput[];
    deliveries: Delivery[];
    creation?: CreateCreditParams;
    draw?: CreditDrawParams;
    cancel?: CancelCreditParams;
    topUp?: TopUpCreditParams;
    amounts?: bigint[];
}
export interface OperationPlan {
    intent?: import("../broadcaster-preparation").PreparationIntent;
    version: 1;
    id: string;
    kind:
        "transfer" | "shield" | "create-credit" | "draw-credit" | "top-up-credit" | "cancel-credit";
    context: TransactionContext;
    scope: WalletScope;
    preparedAt: CanonicalBlock;
    deadline: bigint;
    outputs: PreparedOutput[];
    inputs: Array<NoteMembership & { commitment: Hex }>;
    funding: FundingInput;
    fundingMode: "none" | "signature" | "caller";
    params?: TransactRequestParams;
    shieldParams?: ShieldParams;
    shieldOutputs?: ShieldOutput[];
    capacity?: number;
    credit?: CreditPlan;
    statement?: import("@invisi-labs/prover").ProofStatement;
}
export interface SavedOperation {
    plan: OperationPlan;
    broadcasterQuote?: import("../broadcaster").SignedBroadcasterQuote;
    proof?: ProofBundle;
    call?: import("@invisi-labs/protocol").TransactionCall;
    externalized?: boolean;
    generation: number;
    claim?: { stage: string; token: string };
}
export interface TransactionInfrastructure {
    gasBenchmarks?: readonly GasBenchmarkProfile[];
    wallet: Wallet | PublicWallet;
    protocol: Protocol;
    chainReader?: ChainReader;
    protocolRpc?: ProtocolDataProvider;
    prover?: Prover;
    fundingVerifier?: FundingAuthorizationVerifier;
    /** Optional ethers provider used by per-output direct-chain receiving-key lookup. */
    provider?: Provider;
    coinSelector?: CoinSelector;
    transactionTTL?: bigint;
}
export interface TransactionRuntime {
    options: Omit<TransactionInfrastructure, "protocol"> & { protocol: TokenProtocol };
    scope: WalletScope;
    reader: ChainReader;
}
export interface LocalOperationSecrets {
    authorization?: AuthorizedStatement;
}

export interface OperationAggregateMember extends AggregateMember {
    context: TransactionContext;
    request: TransactRequest;
}

/** Data required while preparing an operation; it does not own persistence or reservations. */
export interface PreparationRuntime<Result> extends TransactionRuntime {
    readInventory(): Promise<PreparationInventory>;
    complete(plan: OperationPlan): Promise<Result>;
    explicitInputs?: boolean;
    inputSelection?: readonly Hex[];
    changeAddress?: string;
}

export interface PreparationInventory {
    reservations: Record<string, string>;
    invalidated?: string;
    observedThrough?: Checkpoint;
    notes: Record<string, import("./selection").SelectableNote>;
    credits: Record<
        string,
        Pick<CreditRecord, "state" | "commitment" | "treeId" | "leafIndex" | "role" | "spent">
    >;
}
