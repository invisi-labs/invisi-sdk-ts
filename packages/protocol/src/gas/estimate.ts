import measured from "./data/measured-model.json";
export type DocumentedReleaseIdentity =
    | { creditManifestVersion: number; creditFormatVersion: number; creditManifestSha256?: string }
    | { userManifestVersion: number; userFormatVersion: number };
export type GasShape = Readonly<Record<string, string | number | boolean>>;
export type GasEstimate =
    | { source: "benchmark"; available: false; reason: "shape-not-covered" }
    | {
          source: "benchmark";
          available: true;
          gasUnits: bigint;
          statistic: "median" | "estimate";
          sampleCount: number;
          protocolCommit: string;
          sourceSha256: string;
          docsCommit?: string;
          releaseIdentity?: DocumentedReleaseIdentity;
          referenceId: string;
          document: string;
          conditions: string;
          assumptions: readonly string[];
      };
const flag = (query: GasShape, key: string, fallback = false) =>
    query[key] === undefined ? fallback : query[key] === true;
function count(query: GasShape, key: string, fallback?: number): number {
    const value = query[key] ?? fallback;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
        throw new Error(`Invalid gas shape ${key}`);
    return value;
}
function capacity(tiers: readonly number[], size: number, supplied?: string | number | boolean) {
    const canonical = tiers.find((tier) => tier >= size);
    if (!size || canonical === undefined || (supplied !== undefined && supplied !== canonical))
        throw new Error("Unsupported gas shape capacity");
    return canonical;
}
function result(gas: number, exact: boolean, id: string): GasEstimate {
    if (!Number.isFinite(gas) || gas <= 0) throw new Error("Invalid gas model result");
    return {
        source: "benchmark",
        available: true,
        gasUnits: BigInt(Math.ceil(gas)),
        statistic: exact ? "median" : "estimate",
        sampleCount: exact ? 3 : 0,
        protocolCommit: measured.protocolCommit,
        sourceSha256: measured.sourceSha256,
        referenceId: id,
        document: "05-benchmarks/5.10-sdk-gas-estimation.md",
        conditions:
            "Local Anvil31337 / Prague, Solidity0.8.38 optimizer200, real verifiers, reference ERC20.",
        assumptions: [
            "Pre-signing local fee preview; not an RPC simulation or transaction gas limit.",
            "Token behavior, storage warmth, tree cursor and rollover can change actual gas.",
            "Additional source trees, authorization and delivery bytes use explicit benchmark-calibrated allowances.",
        ],
    };
}
/** Local receipt-calibrated preview. Valid direct shapes always return nonzero gas units. */
export function estimateGas(query: GasShape): GasEstimate {
    const kind = query.kind;
    if (
        ![
            "shield",
            "transact",
            "create-credit",
            "update-credit",
            "revoke-credit",
            "draw-credit",
        ].includes(String(kind))
    )
        return { source: "benchmark", available: false, reason: "shape-not-covered" };
    const fee = flag(query, "feeEnabled", flag(query, "fee"));
    let shape: Record<string, string | number | boolean> = { kind: String(kind), fee };
    let gas: number;
    if (kind === "shield") {
        const outputs = count(query, "noteOutputs");
        if (outputs < 1 || outputs > 10) throw new Error("Unsupported Shield output count");
        shape = { kind, noteOutputs: outputs, fee };
        gas = measured.rows.find(
            (r) => r.shape.kind === kind && r.shape.noteOutputs === outputs && !!r.shape.fee === fee
        )!.gasUnits;
    } else if (kind === "transact") {
        const inputs = count(query, "noteInputs"),
            outputs = count(query, "noteOutputs");
        const tier = capacity(measured.capacities, inputs + outputs, query.capacity);
        if (!inputs && outputs < 2) throw new Error("Single-output public deposits use Shield");
        const deposit = flag(
            query,
            "deposit",
            query.scenario === "public-funding" || query.scenario === "mixed"
        );
        const withdrawal = flag(
            query,
            "withdrawal",
            query.scenario === "withdrawal" || query.scenario === "mixed"
        );
        if ((!inputs && !deposit) || (!outputs && !withdrawal && !fee))
            throw new Error("Unfunded gas shape");
        shape = {
            kind,
            capacity: tier,
            noteInputs: inputs,
            noteOutputs: outputs,
            sourceTrees: count(query, "sourceTrees", inputs ? 1 : 0),
            deposit,
            withdrawal,
            fee,
        };
        if (
            (inputs === 0 && shape.sourceTrees !== 0) ||
            Number(shape.sourceTrees) > inputs ||
            (inputs > 0 && !shape.sourceTrees)
        )
            throw new Error("Invalid source tree count");
        const features = [
            ...measured.capacities.map((c) => Number(c === tier)),
            inputs,
            outputs,
            Number(outputs > 0),
            Number(deposit),
            Number(withdrawal),
            Number(fee),
        ];
        gas =
            features.reduce((sum, x, i) => sum + x * measured.coefficients.transact[i]!, 0) +
            Math.max(0, Number(shape.sourceTrees) - 1) * 10000;
    } else if (kind === "draw-credit") {
        const n = count(query, "creditInputs"),
            tier = capacity(measured.creditCapacities, n, query.capacity);
        const payers = count(query, "distinctPayers", n),
            trees = count(query, "sourceTrees", 1);
        if (payers < 1 || payers > n || trees < 1 || trees > n)
            throw new Error("Invalid draw grouping");
        shape = {
            kind,
            capacity: tier,
            creditInputs: n,
            distinctPayers: payers,
            sourceTrees: trees,
            fee,
        };
        const features = [
            ...measured.creditCapacities.map((c) => Number(c === tier)),
            n,
            payers,
            Number(fee),
        ];
        gas =
            features.reduce((sum, x, i) => sum + x * measured.coefficients.draw[i]!, 0) +
            Math.max(0, trees - 1) * 10000;
    } else {
        if (kind === "revoke-credit")
            shape = {
                ...shape,
                authorization: query.authorization ?? "unknown",
                bitmapWord: query.bitmapWord ?? "empty",
            };
        const row = measured.rows.find((r) =>
            Object.entries(shape).every(([key, value]) => (r.shape as GasShape)[key] === value)
        );
        // Creation/update measurements use the costlier first-allocation/used-state paths.
        if (row) gas = row.gasUnits;
        else if (
            kind === "revoke-credit" &&
            ["direct", "eoa", "erc1271", "unknown"].includes(String(shape.authorization)) &&
            ["empty", "nonempty"].includes(String(shape.bitmapWord))
        ) {
            const fallback = measured.rows.find(
                (r) =>
                    r.shape.kind === kind &&
                    r.shape.fee === fee &&
                    r.shape.authorization === (shape.authorization === "direct" ? "direct" : "eoa")
            )!;
            gas =
                fallback.gasUnits +
                (["erc1271", "unknown"].includes(String(shape.authorization)) ? 60000 : 0);
        } else throw new Error("Unsupported credit authorization shape");
    }
    const noteDeliveries =
        kind === "draw-credit"
            ? 1
            : kind === "transact" || kind === "shield"
              ? count(query, "noteOutputs")
              : 0;
    const creditDeliveries =
        kind === "draw-credit"
            ? 2 * count(query, "creditInputs")
            : kind === "create-credit" || kind === "update-credit"
              ? 2
              : 0;
    const extraBytes =
        count(query, "extraDeliveryBytes", 0) +
        noteDeliveries * Math.max(0, count(query, "noteCiphertextBytes", 160) - 160) +
        creditDeliveries * Math.max(0, count(query, "creditCiphertextBytes", 485) - 485) +
        (noteDeliveries + creditDeliveries) * Math.max(0, count(query, "clueBytes", 68) - 68);
    const extra =
        extraBytes * 32 +
        (flag(query, "permit") ? 70000 : 0) +
        (flag(query, "fundingSignature") ? 40000 : 0);
    const row = measured.rows.find((r) =>
        Object.entries(shape).every(([key, value]) => (r.shape as GasShape)[key] === value)
    );
    const exact = !!row && extra === 0;
    return result(
        (exact ? row.gasUnits : gas) + extra,
        exact,
        exact ? `receipt-${measured.rows.indexOf(row)}` : `${kind}-benchmark-estimate-v1`
    );
}
