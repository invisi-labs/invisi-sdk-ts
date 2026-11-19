import type { CreditUpdateChanges } from "@invisi-labs/primitives";
import type {
    Address,
    RevokeCreditParams,
    CreditCreationParams,
    CreditDrawParams,
    Delivery,
    Hex,
    ShieldOutput,
    ShieldParams,
    UpdateCreditParams,
    TransactRequest,
} from "@invisi-labs/protocol/contracts";
import type { Provider } from "ethers";
import type { NoteOutput } from "../notes/NoteOutput";

import type {
    AuthorizedStatement,
    CreditDeliveryState,
    Note,
    Wallet,
} from "@invisi-labs/primitives";
import type {
    CanonicalBlock,
    ChainReader,
    FundingInput,
    ProtocolDataProvider,
    TransactionContext,
    TransactRequestParams,
} from "@invisi-labs/protocol";
import type { CreditMembership, NoteMembership } from "@invisi-labs/prover";
import type { Protocol, TokenProtocol } from "@invisi-labs/rpc";
import type { AggregateMember, ProofBundle, Prover, ProverOptions } from "@invisi-labs/prover";

import type { Checkpoint, CreditRecord, NoteRecord, WalletScope } from "./records";
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
    context: import("../notes/NoteOutput").NoteOutputContext;
    recipient: import("../notes/NoteOutput").NoteOutputRecipient;
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
    /** Current ABI by default; select legacy only for an older deployment. */
    creationAbi?: "legacy" | "initial-payment";
    /** Gross debit includes the optional broadcaster fee; amount is in token base units. */
    initialPayment?: {
        /** Gross owner debit, including the fee. */
        amount: bigint;
        /** Optional merchant net pin; amount must equal netAmount + fee. Preserved on quotes. */
        netAmount?: bigint;
        payload?: Uint8Array;
    };
    /** Explicit grant correlation key; canonical nonzero field, preserved without derivation. */
    creditSharedKey?: bigint;
    fee?: { recipient: Address; amount: bigint };
    payload?: Uint8Array;
    singleLimit?: bigint;
    dailyLimit?: bigint;
    monthlyLimit?: bigint;
    availableCredit?: bigint;
    unlimited?: boolean;
    tokenAddress: Address;
    spender: string;
    expiry: bigint;
    deadline?: bigint;
}
export interface DrawCreditPreparation {
    fee?: { recipient: Address; amount: bigint };
    tokenAddress: Address;
    credits: readonly { credit: Hex; amount: bigint; payload?: Uint8Array }[];
    recipient: string;
    payload?: Uint8Array;
    deadline?: bigint;
}
export interface UpdateCreditPreparation {
    fee?: { recipient: Address; amount: bigint };
    payload?: Uint8Array;
    singleLimit?: bigint;
    dailyLimit?: bigint;
    monthlyLimit?: bigint;
    increaseAvailableCredit?: bigint;
    decreaseAvailableCredit?: bigint;
    unlimited?: boolean;
    tokenAddress: Address;
    credit: Hex;
    expiry?: bigint;
    deadline?: bigint;
}
export interface RevokeCreditPreparation {
    fee?: { recipient: Address; amount: bigint };
    tokenAddress: Address;
    owner?: Address;
    shard: bigint;
    slot: bigint;
    caller?: Address;
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
    creation?: CreditCreationParams;
    initialPaymentInitialAvailableCredit?: bigint;
    draw?: CreditDrawParams;
    update?: UpdateCreditParams;
    updateChanges?: CreditUpdateChanges;
    revocation?: RevokeCreditParams;
    revocationSignature?: Hex;
    revocationCaller?: Hex;
    amounts?: bigint[];
}
export interface OperationPlan {
    intent?: import("../broadcaster/broadcaster-preparation").PreparationIntent;
    submissionValidation?: "required";
    version: 1;
    id: string;
    kind:
        "transfer" | "shield" | "create-credit" | "draw-credit" | "update-credit" | "revoke-credit";
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
    provenance?: import("../provenance/proof-record").ProvenanceProof;
    broadcasterBinding?: {
        configuration: import("../broadcaster/index").BroadcasterConfiguration;
        intentHash: string;
        scheduleHandle?: import("../broadcaster/index").BroadcasterScheduleHandle;
    };
    broadcasterSubmissionId?: string;
    broadcasterAttempted?: boolean;
    broadcasterCancelled?: boolean;
    broadcasterCancellation?: import("@invisi-labs/rpc/broadcaster").BroadcasterStatus;
    broadcasterRequest?: {
        data: string;
        memberProof?: import("@invisi-labs/rpc/broadcaster").BroadcasterMemberProof;
    };
    broadcasterQuote?: import("../broadcaster/index").SignedBroadcasterQuote;
    proof?: ProofBundle;
    call?: import("@invisi-labs/protocol").TransactionCall;
    externalized?: boolean;
    generation: number;
    claim?: { stage: string; token: string };
}
export interface TransactionInfrastructure {
    provenanceClient?: import("@invisi-labs/rpc/provenance").ProvenanceClient;
    provenance?: import("../broadcaster/provenance-preparation").PreparedProvenanceCapability;
    wallet: Wallet;
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
    preparationReads?: import("./preparation/preparation-reads").PreparationReads;
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
    repricing?: boolean;
    preparationTime?: bigint;
    readSummary?(): Promise<Pick<PreparationInventory, "invalidated" | "observedThrough">>;
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
    notes: Record<string, import("./preparation/selection").SelectableNote>;
    credits: Record<
        string,
        Pick<CreditRecord, "state" | "commitment" | "treeId" | "leafIndex" | "role" | "spent">
    >;
}
