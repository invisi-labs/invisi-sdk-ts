import catalog from "./data/documented-references.json";
export type DocumentedReleaseIdentity =
    | { creditManifestVersion: number; creditFormatVersion: number; creditManifestSha256?: string }
    | { userManifestVersion: number; userFormatVersion: number };
export type GasShape = Readonly<Record<string, string | number | boolean>>;
export type GasEstimate =
    | {
          source: "benchmark";
          available: false;
          reason: "shape-not-covered";
      }
    | {
          source: "benchmark";
          available: true;
          gasUnits: bigint;
          statistic: "median";
          sampleCount: number;
          referenceId: string;
          document: string;
          sourceSha256: string;
          docsCommit: string;
          conditions: string;
          assumptions: readonly string[];
          releaseIdentity: DocumentedReleaseIdentity;
      };
/** Exact documented workload lookup. This is neither a transaction gas limit nor an RPC estimate. */
function lookupReference(query: GasShape): GasEstimate {
    const row = catalog.references.find((r) => {
        const shape = r.shape as GasShape;
        return (
            Object.keys(query).length === Object.keys(shape).length &&
            Object.keys(shape).every((k) => query[k] === shape[k])
        );
    });
    if (!row) return { source: "benchmark", available: false, reason: "shape-not-covered" };
    const source = catalog.sources.find((s) => s.path === row.source)!;
    return {
        source: "benchmark",
        available: true,
        gasUnits: BigInt(row.gasUnits),
        statistic: "median",
        sampleCount: row.sampleCount,
        referenceId: row.id,
        document: row.source,
        sourceSha256: source.sha256,
        docsCommit: catalog.docsCommit,
        conditions: source.conditions,
        assumptions: catalog.assumptions,
        releaseIdentity: row.releaseIdentity as unknown as DocumentedReleaseIdentity,
    };
}

/** Estimate the measured workload locally; this neither simulates nor exports a transaction. */
export function estimateGas(query: GasShape): GasEstimate {
    return lookupReference(query);
}
