import type {} from "@invisi-labs/core";
import type { PublicWallet } from "@invisi-labs/core";
import type { GasBenchmarkProfile } from "../gas-estimation";
import type { Signer } from "ethers";
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

import type {
    AuthorizedStatement,
    CreditDeliveryState,
    Note,
    ReceivingKeyLookup,
    ViewingCapability,
    Wallet,
    WalletAuthorizationProvider,
} from "@invisi-labs/core";
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

import type { StoredCredit, StoredNote, WalletScope, WalletStore, WalletState } from "./state";
export interface CoinSelector {
    select(
        candidates: readonly StoredNote[],
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
export interface PaymentOutput {
    /** Version-specific application data. Omission uses built-in v1 with no data. */
    payload?: Uint8Array;
    to: string;
    amount: bigint;
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
    outputs: readonly PaymentOutput[];
    funding?: FundingSource;
    deadline?: bigint;
}
export interface ShieldPreparation {
    tokenAddress: Address;
    outputs: readonly PaymentOutput[];
    funding: FundingSource;
    deadline?: bigint;
}
export interface PreparedOutput {
    note: Note;
    commitment: Hex;
    identity: Hex;
    delivery: Delivery;
    address: string;
    change: boolean;
}
export interface CreateCreditPreparation {
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
    proof?: ProofBundle;
    call?: import("@invisi-labs/protocol").TransactionCall;
    externalized?: boolean;
    generation: number;
    claim?: { stage: string; token: string };
}
export type WalletSessionOptions = WalletSessionInfrastructure;
/** Shared runtime fields; public options separately enforce the custom registry requirement. */
export interface WalletSessionInfrastructure {
    gasBenchmarks?: readonly GasBenchmarkProfile[];
    /** Optional ethers gas/funding signer; distinct from the Invisi wallet authority. */
    signer?: Signer;
    viewing?: Pick<ViewingCapability, "walletIdentity" | "decryptNote" | "decryptCredit">;
    wallet: Wallet | PublicWallet;
    protocol: Protocol;
    namespace?: string;
    store?: WalletStore;
    chainReader?: ChainReader;
    protocolRpc?: ProtocolDataProvider;
    authorization?: WalletAuthorizationProvider;
    prover?: Prover;
    fundingSigner?: FundingSigner;
    fundingVerifier?: FundingAuthorizationVerifier;
    addressResolver?: ReceivingKeyLookup;
    coinSelector?: CoinSelector;
    transactionTTL?: bigint;
}
export interface OperationRuntime {
    options: Omit<WalletSessionOptions, "protocol"> & {
        protocol: TokenProtocol;
    };
    scope: WalletScope;
    store: WalletStore;
    reader: ChainReader;
    authorization: () => WalletAuthorizationProvider;
}
export interface LocalOperationSecrets {
    authorization?: AuthorizedStatement;
}

export interface OperationAggregateMember extends AggregateMember {
    context: TransactionContext;
    request: TransactRequest;
}

/** Data required while preparing an operation; it does not own persistence or reservations. */
export interface PreparationRuntime<Result> extends Omit<OperationRuntime, "store"> {
    readInventory(): Promise<PreparationInventory>;
    complete(plan: OperationPlan): Promise<Result>;
    explicitInputs?: boolean;
    inputSelection?: readonly Hex[];
    changeAddress?: string;
}

export interface PreparationInventory extends Pick<
    WalletState,
    "reservations" | "invalidated" | "observedThrough"
> {
    notes: Record<string, import("./selection").SelectableNote>;
    credits: Record<
        string,
        Pick<StoredCredit, "state" | "commitment" | "treeId" | "leafIndex" | "role" | "spent">
    >;
}
