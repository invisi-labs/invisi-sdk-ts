import type { CanonicalBlock } from "@invisi-labs/rpc";
export type {
    CanonicalBlock,
    Membership,
    ProtocolDataStatus,
    ProtocolUpdateRange,
    ProtocolUpdates,
    ProtocolDataProvider,
} from "@invisi-labs/rpc";
import type { Address, Hex } from "./contracts";

import type { DeploymentContext } from "./validation";
export interface ProtocolLog {
    address: Address;
    data: Hex;
    topics: readonly Hex[];
    transactionHash: Hex;
    logIndex: number;
}
export interface CanonicalReceipt {
    block: CanonicalBlock;
    transactionHash: Hex;
    logs: readonly ProtocolLog[];
    status?: "success" | "reverted";
}
export interface ChainReader {
    getChainId(): Promise<bigint>;
    /** Required when a selected deployment includes a receiving-key registry. */
    getProtocolAddressRegistry?(address: Address): Promise<Address>;
    getCode(address: Address): Promise<Hex>;
    getBlock(number: bigint): Promise<CanonicalBlock>;
    getLatestBlockNumber(): Promise<bigint>;
    getFundingNonce(
        context: DeploymentContext,
        payer: Address,
        block: CanonicalBlock
    ): Promise<bigint>;
    isKnownRoot(
        context: DeploymentContext,
        treeId: bigint,
        root: Hex,
        block: CanonicalBlock
    ): Promise<boolean>;
    getTransaction(
        hash: Hex
    ): Promise<(TransactionCall & { transactionHash: Hex; from: Address; nonce: bigint }) | null>;
    getReceipt(hash: Hex): Promise<CanonicalReceipt | null>;
    isSpent(
        context: DeploymentContext,
        nullifiers: readonly Hex[],
        block: CanonicalBlock
    ): Promise<readonly boolean[]>;
}
export interface TransactionCall {
    to: Address;
    data: Hex;
    value: bigint;
}
/** Optional deployment provenance queries, independent of token policy. */
export interface FactoryReader {
    getFactoryInstanceAddress(factory: Address, salt: Hex): Promise<Address>;
    isFactoryInstance(factory: Address, instance: Address): Promise<boolean>;
    getInstanceFactory(instance: Address): Promise<Address>;
}
