import { defaultProfiles, sameCircuit, shapeKeys } from "./profiles";
import { GasBenchmarkProfile, GasBenchmarkShape, GasEstimateRequest, GasReference } from "./types";

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
    const exact = matching.filter((measurement) =>
        shapeKeys.every((key) => measurement.shape[key] === request.shape[key])
    );
    if (exact.length) {
        const means = exact.map((m) => {
            const count = BigInt(m.samples.length);
            return (m.samples.reduce((sum, s) => sum + BigInt(s.gasUsed), 0n) + count - 1n) / count;
        });
        return { gasUnits: means.reduce((max, v) => (v > max ? v : max)) };
    }
    if (
        ["create-credit", "draw-credit", "top-up-credit", "cancel-credit"].includes(
            request.shape.kind
        ) &&
        !matching.length
    )
        throw new Error("No current Credit gas reference for this artifact and verification key");
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
    // Same public shape may have several private-policy variants. Use their worst observed
    // receipt before comparing different workload baselines, so a cheaper variant cannot win.
    const groups = new Map<string, (typeof candidates)[number]>();
    for (const candidate of candidates) {
        const key = JSON.stringify([
            shapeKeys.map((k) => candidate.shape[k]),
            candidate.circuit?.circuitName,
            candidate.circuit?.target,
            candidate.circuit?.artifactSha256.toLowerCase(),
            candidate.circuit?.vkSha256.toLowerCase(),
        ]);
        const previous = groups.get(key);
        groups.set(
            key,
            previous
                ? { ...candidate, samples: [...previous.samples, ...candidate.samples] }
                : candidate
        );
    }
    const estimates = [...groups.values()].map((measurement) => {
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
