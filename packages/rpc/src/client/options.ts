import type { Hex } from "@invisi-labs/core";
import { type ProtocolDeployment } from "../deployment/deployment";
import type { CanonicalBlock, DeploymentContext } from "../types";

export interface ProtocolRpcReader {
    getBlock(number: bigint): Promise<CanonicalBlock>;
    isKnownRoot(
        context: DeploymentContext,
        treeId: bigint,
        root: Hex,
        block: CanonicalBlock
    ): Promise<boolean>;
}

export interface ProtocolRpcConnectionOptions {
    /** Versioned service URL, or an explicitly discovered chain endpoint for a chain client. */
    url: string;
    token?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
}

export interface ProtocolRpcClientOptions extends ProtocolRpcConnectionOptions {
    deployment?: ProtocolDeployment;
    reader?: ProtocolRpcReader;
}

export interface ProtocolRpcChain {
    readonly chainId: bigint;
    readonly protocolVersion: "1";
    readonly rpcUrl: string;
}
