import type { Address, Hex } from "@invisi-labs/core";
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
export interface ProtocolUpdates {
    block: CanonicalBlock;
    transactionHashes: readonly Hex[];
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
    getUpdates(context: DeploymentContext, range: ProtocolUpdateRange): Promise<ProtocolUpdates>;
}

/** Registered public receiving address returned by a trusted indexed RPC read. */
export interface RegisteredReceivingAddress {
    receivingAddress: string;
    nonce: bigint;
    block: CanonicalBlock;
}

/** Indexed encrypted output; authenticate decryption and verify membership before spending. */
export interface ProtocolOutput {
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
