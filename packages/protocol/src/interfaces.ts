import type { CanonicalBlock, CreditGrantStatus } from "./rpc-types";
import type { Address, Hex } from "./contracts/index";
export type {
    CanonicalBlock,
    CreditGrantStatus,
    Membership,
    ProtocolDataProvider,
    ProtocolDataStatus,
    ProtocolUpdateRange,
} from "./rpc-types";

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
    getTokenBalanceAllowance?(
        context: DeploymentContext,
        owner: Address,
        token: Address,
        block: CanonicalBlock
    ): Promise<{ balance: bigint; allowance: bigint }>;
    getCreditStatus?(
        context: DeploymentContext,
        owner: Address,
        token: Address,
        grantId: bigint,
        block: CanonicalBlock
    ): Promise<CreditGrantStatus>;
    getChainId(): Promise<bigint>;
    /** Required when a selected deployment includes a receiving-key registry. */
    getProtocolAddressRegistry?(address: Address, block?: CanonicalBlock): Promise<Address>;
    getProtocolVersion?(address: Address, block?: CanonicalBlock): Promise<bigint>;
    getCode(address: Address, block?: CanonicalBlock): Promise<Hex>;
    getBlock(number: bigint): Promise<CanonicalBlock>;
    /** Optional bounded full-header acquisition; callers still verify ordering and canonical anchors. */
    getBlocks?(numbers: readonly bigint[]): Promise<readonly CanonicalBlock[]>;
    getBlockByTag?(tag: import("./finality").FinalityTag): Promise<CanonicalBlock | null>;
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
