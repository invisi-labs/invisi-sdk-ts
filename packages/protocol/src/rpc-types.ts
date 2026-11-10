import type { Address, Hex } from "@invisi-labs/primitives";
export interface DeploymentContext {
    chainId: bigint;
    protocolAddress: Address;
}
export interface CanonicalBlock {
    number: bigint;
    hash: Hex;
    parentHash: Hex;
    timestamp: bigint;
}
export interface Membership {
    treeId: bigint;
    leafIndex: number;
    leaf: Hex;
    root: Hex;
    path: readonly bigint[];
    block: CanonicalBlock;
}
/** Indexed service data is untrusted; the wallet verifies canonical facts through ChainReader. */
export interface ProtocolDataStatus {
    indexedHead: CanonicalBlock | null;
    detectionEnabled: boolean;
    checkedBits: number;
}
export interface ProtocolUpdateRange {
    fromBlock: bigint;
    toBlock: bigint;
    detectionKey?: Uint8Array;
    signal?: AbortSignal;
}
export interface ProtocolNoteUpdates {
    block: CanonicalBlock;
    notes: readonly ProtocolNoteOutput[];
}
export interface ProtocolCreditUpdates {
    block: CanonicalBlock;
    transitions: readonly ProtocolCreditTransition[];
}
export interface ProtocolCreditCandidates {
    block: CanonicalBlock;
    states: readonly IndexedCreditState[];
}
export interface ProtocolDataProvider {
    getMembership(
        context: DeploymentContext,
        input: { treeId: bigint; leafIndex: number; commitment: Hex; root?: Hex },
        block: CanonicalBlock
    ): Promise<Membership>;
    getStatus(
        context: DeploymentContext,
        options?: { signal?: AbortSignal }
    ): Promise<ProtocolDataStatus>;
    getNoteUpdates(
        context: DeploymentContext,
        range: ProtocolUpdateRange
    ): Promise<ProtocolNoteUpdates>;
    getCreditTransitions(
        context: DeploymentContext,
        range: ProtocolUpdateRange
    ): Promise<ProtocolCreditUpdates>;
    detectNotes(
        context: DeploymentContext,
        range: ProtocolUpdateRange
    ): Promise<ProtocolNoteUpdates>;
    detectCreditStates(
        context: DeploymentContext,
        range: ProtocolUpdateRange
    ): Promise<ProtocolCreditCandidates>;
}

/** Registered public receiving address returned by a trusted indexed RPC read. */
export interface RegisteredReceivingAddress {
    receivingAddress: string;
    nonce: bigint;
    block: CanonicalBlock;
}

/** Indexed encrypted output; authenticate decryption and verify membership before spending. */
export interface ProtocolNoteOutput {
    block: CanonicalBlock;
    treeId: bigint;
    leafIndex: number;
    commitment: Hex;
    tokenAddress: Address;
    ciphertext: Hex;
    clue: Hex;
    transactionHash: Hex;
    logIndex: number;
    kind: string;
}

/** Public indexed Credit event data; verify the canonical receipt before using it. */
export interface ProtocolCreditTransition {
    block: CanonicalBlock;
    name: "CreditCreated" | "CreditDraw" | "CreditUpdated" | "CreditRevoked";
    transactionHash: Hex;
    logIndex: number;
    data: Readonly<Record<string, unknown>>;
}

/** One public authority leaf retains both owner/spender deliveries in on-chain order. */
export interface IndexedCreditState {
    block: CanonicalBlock;
    treeId: bigint;
    leafIndex: number;
    commitment: Hex;
    tokenAddress: Address;
    deliveries: readonly { ciphertext: Hex; clue: Hex }[];
    transactionHash: Hex;
    logIndex: number;
    kind: "CreditCreated" | "CreditDraw" | "CreditUpdated";
}
interface TransactionCommon {
    transactionHash: Hex;
    indexedHead: CanonicalBlock | null;
}
type Availability<Collections> = TransactionCommon &
    (
        | ({ status: "not_found"; block: null; receiptStatus: null } & {
              [K in keyof Collections]: null;
          })
        | ({ status: "pending_index"; block: CanonicalBlock; receiptStatus: 0 | 1 } & {
              [K in keyof Collections]: null;
          })
        | ({ status: "indexed"; block: CanonicalBlock; receiptStatus: 0 | 1 } & Collections)
    );
export type ProtocolTransactionNoteUpdates = Availability<{ notes: readonly ProtocolNoteOutput[] }>;
export type ProtocolTransactionCreditUpdates = Availability<{
    states: readonly IndexedCreditState[];
    transitions: readonly ProtocolCreditTransition[];
}>;
export interface IndexedCreditAllocation {
    block: CanonicalBlock;
    shard: bigint;
    slot: number;
}
export interface IndexedCreditRevocationBitmap {
    block: CanonicalBlock;
    bitmap: bigint;
}

/** Public operator metadata from the selected registry's indexed state; not an endorsement. */
export interface RegisteredBroadcaster {
    block: CanonicalBlock;
    operator: Address;
    /** Raw contract declaration; the contact client must validate URL safety before use. */
    endpoint: string;
    metadataURI: string;
    quoteSigner: Address;
    feeRecipient: Address;
    enabled: boolean;
}
export interface BroadcasterQuery {
    enabled?: boolean;
    after?: Address;
    limit?: number;
    block?: CanonicalBlock;
    signal?: AbortSignal;
}
export interface BroadcasterPage {
    block: CanonicalBlock;
    broadcasters: readonly RegisteredBroadcaster[];
    next?: Address;
}
