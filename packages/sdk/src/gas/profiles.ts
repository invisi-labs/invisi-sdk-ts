import referenceProfiles from "./data/gas-benchmarks.json";
import {
    GasBenchmarkCircuit,
    GasBenchmarkDeployment,
    GasBenchmarkProfile,
    GasBenchmarkShape,
} from "./types";

const word = /^0x[0-9a-fA-F]{64}$/;

export const address = /^0x[0-9a-fA-F]{40}$/;

const decimal = /^(0|[1-9][0-9]*)$/;

export const shapeKeys: Array<keyof GasBenchmarkShape> = [
    "kind",
    "target",
    "capacity",
    "noteInputs",
    "noteOutputs",
    "sourceTrees",
    "creditInputs",
    "creditOutputs",
    "creditRemainders",
    "funding",
    "permit",
    "deliveryBytes",
];

/** Copy trusted benchmark records; validation checks format, not their publisher's honesty. */
export function copyGasBenchmarks(profiles: readonly GasBenchmarkProfile[]): GasBenchmarkProfile[] {
    const copy = structuredClone([...profiles]);
    for (const p of copy) {
        if (
            p.formatVersion !== 1 ||
            !p.id ||
            !decimal.test(p.deployment.chainId) ||
            !address.test(p.deployment.protocolAddress) ||
            !address.test(p.deployment.tokenAddress) ||
            !p.deployment.runtimeCodeHash ||
            !word.test(p.deployment.runtimeCodeHash) ||
            p.source.verifier !== "real" ||
            !/^[0-9a-f]{40}$/i.test(p.source.protocolCommit) ||
            !p.source.measuredAt ||
            !Array.isArray(p.source.assumptions) ||
            !p.source.assumptions.every((assumption) => typeof assumption === "string") ||
            !p.measurements.length
        )
            throw new Error("invalid gas benchmark profile");
        if (
            p.source.fingerprints &&
            ![
                "protocolSourceSha256",
                "dirtyDiffSha256",
                "compiledArtifactsSha256",
                "creditManifestSha256",
                "userManifestSha256",
                "sdkSourceSha256",
            ].every((key) => {
                const v = (p.source.fingerprints as unknown as Record<string, unknown>)[key];
                return typeof v === "string" && /^[a-f0-9]{64}$/i.test(v);
            })
        )
            throw new Error("invalid benchmark source fingerprint");
        if (
            p.source.blockGasLimit !== undefined &&
            (!decimal.test(p.source.blockGasLimit) || BigInt(p.source.blockGasLimit) <= 0n)
        )
            throw new Error("invalid benchmark block gas limit");
        if (
            p.source.runtimeContracts &&
            !Object.values(p.source.runtimeContracts).every(
                (v) => address.test(v.address) && word.test(v.runtimeCodeHash)
            )
        )
            throw new Error("invalid benchmark runtime identity");
        if (
            p.source.toolchain &&
            (!["solidity", "barretenberg", "noir", "evmVersion", "anvil"].every((key) => {
                const v = (p.source.toolchain as unknown as Record<string, unknown>)[key];
                return typeof v === "string" && v.length > 0;
            }) ||
                !Number.isSafeInteger(p.source.toolchain.optimizerRuns) ||
                p.source.toolchain.optimizerRuns < 0)
        )
            throw new Error("invalid benchmark toolchain");
        for (const m of p.measurements) {
            if (
                !m.id ||
                !m.samples.length ||
                !["none", "caller", "signature"].includes(m.shape.funding) ||
                typeof m.shape.permit !== "boolean"
            )
                throw new Error("invalid gas benchmark measurement");
            for (const key of shapeKeys) {
                const value = m.shape[key];
                if (
                    !["kind", "target", "funding", "permit"].includes(key) &&
                    (!Number.isSafeInteger(value) || Number(value) < 0)
                )
                    throw new Error("invalid gas benchmark shape");
            }
            if (
                m.circuit &&
                (![m.circuit.artifactSha256, m.circuit.vkSha256].every((hash) =>
                    /^[a-f0-9]{64}$/i.test(hash)
                ) ||
                    !m.circuit.circuitName ||
                    !m.circuit.target)
            )
                throw new Error("invalid gas benchmark circuit identity");
            const hashes = new Set<string>();
            for (const sample of m.samples) {
                if (
                    typeof sample.gasUsed !== "string" ||
                    !decimal.test(sample.gasUsed) ||
                    BigInt(sample.gasUsed) <= 0n ||
                    !word.test(sample.transactionHash) ||
                    !word.test(sample.blockHash) ||
                    !decimal.test(sample.blockNumber) ||
                    !Number.isSafeInteger(sample.calldataBytes) ||
                    sample.calldataBytes < 0 ||
                    hashes.has(sample.transactionHash.toLowerCase())
                )
                    throw new Error("invalid gas benchmark receipt");
                hashes.add(sample.transactionHash.toLowerCase());
            }
        }
    }
    return copy;
}

/** Parse a trusted, JSON-compatible benchmark catalog. No network access or publisher authentication. */
export function defineGasBenchmarks(input: unknown): GasBenchmarkProfile[] {
    if (!Array.isArray(input)) throw new Error("invalid gas benchmark catalog");
    try {
        return copyGasBenchmarks(input as GasBenchmarkProfile[]);
    } catch {
        throw new Error("invalid gas benchmark catalog");
    }
}

export const defaultProfiles = defineGasBenchmarks(referenceProfiles);

export function sameDeployment(a: GasBenchmarkDeployment, b: GasBenchmarkDeployment) {
    return (
        a.chainId === b.chainId &&
        a.protocolAddress.toLowerCase() === b.protocolAddress.toLowerCase() &&
        a.tokenAddress.toLowerCase() === b.tokenAddress.toLowerCase() &&
        a.runtimeCodeHash?.toLowerCase() === b.runtimeCodeHash?.toLowerCase()
    );
}

export function sameCircuit(a: GasBenchmarkCircuit | null, b: GasBenchmarkCircuit | null) {
    return a === null
        ? b === null
        : b !== null &&
              a.circuitName === b.circuitName &&
              a.target === b.target &&
              a.artifactSha256.toLowerCase() === b.artifactSha256.toLowerCase() &&
              a.vkSha256.toLowerCase() === b.vkSha256.toLowerCase();
}
