import type { Hex } from "@invisi-labs/core";
import type { TokenProtocol } from "@invisi-labs/protocol";
import type { OperationPlan } from "./session/operation-types";
import { operationSources } from "./session/operation-protocol";
import referenceProfiles from "./data/gas-benchmarks.json";

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
const word = /^0x[0-9a-fA-F]{64}$/;
const address = /^0x[0-9a-fA-F]{40}$/;
const decimal = /^(0|[1-9][0-9]*)$/;
const shapeKeys: Array<keyof GasBenchmarkShape> = [
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
const defaultProfiles = defineGasBenchmarks(referenceProfiles);

function sameDeployment(a: GasBenchmarkDeployment, b: GasBenchmarkDeployment) {
    return (
        a.chainId === b.chainId &&
        a.protocolAddress.toLowerCase() === b.protocolAddress.toLowerCase() &&
        a.tokenAddress.toLowerCase() === b.tokenAddress.toLowerCase() &&
        a.runtimeCodeHash?.toLowerCase() === b.runtimeCodeHash?.toLowerCase()
    );
}
function sameCircuit(a: GasBenchmarkCircuit | null, b: GasBenchmarkCircuit | null) {
    return a === null
        ? b === null
        : b !== null &&
              a.circuitName === b.circuitName &&
              a.target === b.target &&
              a.artifactSha256.toLowerCase() === b.artifactSha256.toLowerCase() &&
              a.vkSha256.toLowerCase() === b.vkSha256.toLowerCase();
}

/** Pure reference lookup. No proof, RPC, current fee price, extrapolation or transaction gas limit. */
export function estimateBenchmarkGas(
    plan: OperationPlan,
    protocol: TokenProtocol,
    profiles?: readonly GasBenchmarkProfile[]
): BenchmarkGasEstimate {
    const credit = plan.credit;
    const deliveries = credit?.deliveries ?? plan.outputs.map((out) => out.delivery);
    const request: GasEstimateRequest = {
        deployment: {
            chainId: plan.context.chainId.toString(),
            protocolAddress: plan.context.protocolAddress,
            runtimeCodeHash: protocol.expectedRuntimeCodeHash ?? null,
            tokenAddress: plan.context.tokenAddress,
        },
        shape: {
            kind: plan.kind,
            target: plan.statement?.target ?? "evm",
            capacity: plan.capacity ?? 0,
            noteInputs: plan.inputs.length,
            noteOutputs: plan.outputs.length,
            sourceTrees: operationSources(plan).length,
            creditInputs: credit?.inputs.length ?? 0,
            creditOutputs: credit?.outputs.length ?? 0,
            creditRemainders:
                credit?.draw?.remainderCommitments.filter((hash) => BigInt(hash) !== 0n).length ??
                0,
            funding: plan.fundingMode,
            permit: (plan.funding.permit?.deadline ?? 0n) !== 0n,
            deliveryBytes: deliveries.reduce(
                (sum, d) => sum + (d.ciphertext.length - 2) / 2 + (d.clue.length - 2) / 2,
                0
            ),
        },
        circuit: plan.statement
            ? {
                  circuitName: plan.statement.circuitName,
                  target: plan.statement.target,
                  artifactSha256: plan.statement.artifactSha256,
                  vkSha256: plan.statement.vkSha256,
              }
            : null,
    };
    const base = { source: "benchmark" as const, request };
    if (request.shape.target === "noir-recursive")
        return { ...base, available: false, reason: "recursive-member-only" };
    const candidates = (profiles ?? defaultProfiles).filter((p) =>
        sameDeployment(p.deployment, request.deployment)
    );
    if (!request.deployment.runtimeCodeHash || !candidates.length)
        return { ...base, available: false, reason: "deployment-not-covered" };
    for (const profile of candidates) {
        const measurement = profile.measurements.find(
            (m) =>
                shapeKeys.every((key) => m.shape[key] === request.shape[key]) &&
                sameCircuit(m.circuit, request.circuit)
        );
        if (!measurement) continue;
        const gas = measurement.samples.map((sample) => BigInt(sample.gasUsed));
        const count = BigInt(gas.length);
        return {
            ...base,
            available: true,
            gasUnits: (gas.reduce((sum, value) => sum + value, 0n) + count - 1n) / count,
            range: {
                min: gas.reduce((a, b) => (a < b ? a : b)),
                max: gas.reduce((a, b) => (a > b ? a : b)),
                kind: "observed",
            },
            samples: gas.length,
            profileId: profile.id,
            measurementId: measurement.id,
            evidence: structuredClone(profile.source),
        };
    }
    return { ...base, available: false, reason: "shape-not-covered" };
}

/** Pre-proof reference only; ethers must estimate the final transaction independently. */
export interface GasReference {
    gasUnits: bigint;
}

/** Internal workload envelope for combinations without an exact receipt measurement. */
export function estimateShapeGas(
    request: GasEstimateRequest,
    profiles: readonly GasBenchmarkProfile[] = defaultProfiles
): GasReference {
    if (request.shape.target === "noir-recursive") {
        throw new Error(
            "Estimate gas for the complete aggregate, not an individual recursive member"
        );
    }
    const measurements = profiles.flatMap((profile) => profile.measurements);
    const matching = measurements.filter(
        (measurement) =>
            measurement.shape.kind === request.shape.kind &&
            measurement.shape.target === request.shape.target &&
            sameCircuit(measurement.circuit, request.circuit)
    );
    const exact = matching.find((measurement) =>
        shapeKeys.every((key) => measurement.shape[key] === request.shape[key])
    );
    if (exact) {
        const gas = exact.samples.map((sample) => BigInt(sample.gasUsed));
        const count = BigInt(gas.length);
        return { gasUnits: (gas.reduce((sum, value) => sum + value, 0n) + count - 1n) / count };
    }
    const candidates = matching.length
        ? matching
        : measurements.filter(
              (measurement) =>
                  measurement.shape.kind === request.shape.kind &&
                  measurement.shape.target === request.shape.target
          );
    if (!candidates.length) throw new Error("No gas reference for this operation kind and target");
    // Scale upward only. This intentionally overcounts shared verification work rather than
    // claiming a calibrated marginal cost for unmeasured input, tree or authorization paths.
    const dimensions = [
        "noteInputs",
        "noteOutputs",
        "sourceTrees",
        "creditInputs",
        "creditOutputs",
        "creditRemainders",
        "deliveryBytes",
        ...(!matching.length ? ["capacity"] : []),
    ] as const;
    const estimates = candidates.map((measurement) => {
        let numerator = 1n;
        let denominator = 1n;
        for (const key of dimensions) {
            const current = BigInt(request.shape[key as keyof GasBenchmarkShape] as number) + 1n;
            const baseline =
                BigInt(measurement.shape[key as keyof GasBenchmarkShape] as number) + 1n;
            if (current * denominator > numerator * baseline) {
                numerator = current;
                denominator = baseline;
            }
        }
        let gas = measurement.samples.reduce(
            (max, sample) => (BigInt(sample.gasUsed) > max ? BigInt(sample.gasUsed) : max),
            0n
        );
        gas = (gas * numerator + denominator - 1n) / denominator;
        // These external calls were absent from the bundled receipt matrix. Reserve the cost
        // of one complete measured operation for each additional authorization mechanism.
        if (request.shape.funding === "signature" && measurement.shape.funding !== "signature")
            gas *= 2n;
        if (request.shape.permit && !measurement.shape.permit) gas *= 2n;
        return gas;
    });
    return { gasUnits: estimates.reduce((min, gas) => (gas < min ? gas : min)) };
}

export function estimateGasReference(
    plan: OperationPlan,
    protocol: TokenProtocol,
    profiles?: readonly GasBenchmarkProfile[]
): GasReference {
    const reference = estimateBenchmarkGas(plan, protocol, profiles);
    if (reference.available) return { gasUnits: reference.gasUnits };
    // Team records take priority only for their exact deployment and shape. The built-in
    // reference model is deployment-independent and covers the current SDK operation family.
    return estimateShapeGas(reference.request);
}
