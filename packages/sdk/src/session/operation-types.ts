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
import type { AggregateMember, ProofBundle, ProofTarget, Prover } from "@invisi-labs/prover";

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
    to: string;
    amount: bigint;
}
export interface TransferPreparation {
    tokenAddress: Address;
    outputs: readonly PaymentOutput[];
    funding?: FundingSource;
    deadline?: bigint;
    target?: ProofTarget;
}
export interface WithdrawalPreparation {
    tokenAddress: Address;
    to: Address;
    amount: bigint;
    deadline?: bigint;
    target?: ProofTarget;
}
export interface SweepPreparation {
    tokenAddress: Address;
    commitments?: readonly Hex[];
    deadline?: bigint;
    target?: ProofTarget;
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
    tokenAddress: Address;
    spender: string;
    amount: bigint;
    expiry: bigint;
    funding?: FundingSource;
    deadline?: bigint;
}
export interface DrawCreditPreparation {
    tokenAddress: Address;
    credits: readonly { credit: Hex; amount: bigint }[];
    deadline?: bigint;
}
export interface TopUpCreditPreparation {
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
        | "transfer"
        | "withdraw"
        | "sweep"
        | "shield"
        | "create-credit"
        | "draw-credit"
        | "top-up-credit"
        | "cancel-credit";
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
export interface WalletSessionOptions {
    gasBenchmarks?: readonly GasBenchmarkProfile[];
    /** Optional ethers gas/funding signer; distinct from the Invisi wallet authority. */
    signer?: Signer;
    viewing?: Pick<ViewingCapability, "walletIdentity" | "decryptNote" | "decryptCredit">;
    wallet: Wallet;
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
    options: Omit<WalletSessionOptions, "protocol"> & { protocol: TokenProtocol };
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
