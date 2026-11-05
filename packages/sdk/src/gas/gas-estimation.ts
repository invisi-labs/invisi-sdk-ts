import type { TokenProtocol } from "@invisi-labs/protocol";
import type { OperationPlan } from "../transactions/operation-types";
import { operationSources } from "../transactions/preparation/inputs";
import { defaultProfiles, sameCircuit, sameDeployment, shapeKeys } from "./profiles";
import { estimateShapeGas } from "./shape";
import {
    BenchmarkGasEstimate,
    GasBenchmarkProfile,
    GasEstimateRequest,
    GasReference,
} from "./types";

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
    const exact = candidates.flatMap((profile) =>
        profile.measurements
            .filter(
                (m) =>
                    shapeKeys.every((key) => m.shape[key] === request.shape[key]) &&
                    sameCircuit(m.circuit, request.circuit)
            )
            .map((measurement) => ({ profile, measurement }))
    );
    const mean = (measurement: GasBenchmarkProfile["measurements"][number]) => {
        const count = BigInt(measurement.samples.length);
        return (
            (measurement.samples.reduce((sum, s) => sum + BigInt(s.gasUsed), 0n) + count - 1n) /
            count
        );
    };
    exact.sort((a, b) =>
        mean(a.measurement) > mean(b.measurement)
            ? -1
            : mean(a.measurement) < mean(b.measurement)
              ? 1
              : a.measurement.id.localeCompare(b.measurement.id)
    );
    if (exact.length) {
        const { profile, measurement } = exact[0]!;
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

export {
    BenchmarkGasEstimate,
    GasBenchmarkCircuit,
    GasBenchmarkDeployment,
    GasBenchmarkProfile,
    GasBenchmarkSample,
    GasBenchmarkShape,
    GasEstimateRequest,
    GasReference,
} from "./types";

export { copyGasBenchmarks, defineGasBenchmarks } from "./profiles";

export { estimateShapeGas } from "./shape";
