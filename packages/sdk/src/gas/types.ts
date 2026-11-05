import type { Hex } from "@invisi-labs/core";
import type { OperationPlan } from "../transactions/operation-types";

export interface GasBenchmarkShape {
    kind: OperationPlan["kind"];
    target: string;
    capacity: number;
    noteInputs: number;
    noteOutputs: number;
    sourceTrees: number;
    creditInputs: number;
    creditOutputs: number;
    creditRemainders: number;
    funding: "none" | "caller" | "signature";
    permit: boolean;
    deliveryBytes: number;
}

export interface GasBenchmarkDeployment {
    chainId: string;
    protocolAddress: Hex;
    runtimeCodeHash: Hex | null;
    tokenAddress: Hex;
}

export interface GasBenchmarkCircuit {
    circuitName: string;
    target: string;
    artifactSha256: string;
    vkSha256: string;
}

export interface GasBenchmarkSample {
    gasUsed: string;
    transactionHash: Hex;
    blockNumber: string;
    blockHash: Hex;
    calldataBytes: number;
}

export interface GasBenchmarkProfile {
    formatVersion: 1;
    id: string;
    deployment: GasBenchmarkDeployment;
    source: {
        protocolCommit: string;
        fingerprints?: {
            protocolSourceSha256: string;
            dirtyDiffSha256: string;
            compiledArtifactsSha256: string;
            creditManifestSha256: string;
            userManifestSha256: string;
            sdkSourceSha256: string;
        };
        toolchain?: {
            solidity: string;
            barretenberg: string;
            noir: string;
            evmVersion: string;
            optimizerRuns: number;
            anvil: string;
        };
        blockGasLimit?: string;
        runtimeContracts?: Record<string, { address: Hex; runtimeCodeHash: Hex }>;
        measuredAt: string;
        chain: string;
        hardfork: string;
        token: string;
        verifier: "real";
        assumptions: string[];
    };
    measurements: Array<{
        id: string;
        shape: GasBenchmarkShape;
        circuit: GasBenchmarkCircuit | null;
        samples: GasBenchmarkSample[];
    }>;
}

export interface GasEstimateRequest {
    deployment: GasBenchmarkDeployment;
    shape: GasBenchmarkShape;
    circuit: GasBenchmarkCircuit | null;
}

export type BenchmarkGasEstimate = {
    source: "benchmark";
    request: GasEstimateRequest;
} & (
    | {
          available: false;
          reason: "deployment-not-covered" | "shape-not-covered" | "recursive-member-only";
      }
    | {
          available: true;
          gasUnits: bigint;
          range: { min: bigint; max: bigint; kind: "observed" };
          samples: number;
          profileId: string;
          measurementId: string;
          evidence: GasBenchmarkProfile["source"];
      }
);

/** Pre-proof reference only; ethers must estimate the final transaction independently. */
export interface GasReference {
    gasUnits: bigint;
}
